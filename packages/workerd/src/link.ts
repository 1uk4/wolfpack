/**
 * HubLink: workerd's single WebSocket to the hub (GET /v1/link). Opens with `hello`, reports wolves added/removed, answers pings,
 * reconnects with backoff 1s -> 60s (+-20% jitter, never above the cap) and at once on kick() (wake / network change).
 *
 * Uses the `ws` client (not the global WebSocket) because only `ws` exposes the HTTP status of a refused upgrade (401/403).
 * "unauthorized", "incompatible" and "replaced" are sticky: the state and detail survive retries (unauthorized retries at the cap,
 * incompatible every 15 min, replaced every 30 min +-20%) until a welcome arrives.
 */
import WebSocket from "ws";
import { machineName } from "@wolfpack/protocol/health-lag";
import { LINK_PATH, LINK_PROTOCOL_VERSION, encodeLinkFrame, parseLinkFrame, type LinkFrame, type LinkReceipt, type LinkWelcome, type LinkWolf } from "@wolfpack/protocol";
import type { CommandKind, LinkCmd, LinkCmdResult } from "@wolfpack/protocol";
import type { Outbox } from "./outbox.js";

export type LinkState = "idle" | "connecting" | "online" | "backoff" | "incompatible" | "unauthorized" | "replaced" | "stopped";
const STICKY: ReadonlySet<LinkState> = new Set(["incompatible", "unauthorized", "replaced"]);

export interface HubLinkOptions {
  hubUrl: string;
  token: string;
  hostId: string;
  /** Default `process.platform === "darwin"`. A clean close of a laptop shows as "asleep" at the hub. */
  laptop?: boolean;
  wolves: () => LinkWolf[];
  /** Per-domain KB cursors to report in hello. */
  kbRevisions?: () => Record<string, number>;
  log?: (m: string) => void;
  /** Injectables for tests. */
  rand?: () => number;
  WebSocketImpl?: typeof WebSocket;
  baseMs?: number;
  capMs?: number;
  /** TCP+upgrade must finish within this. Default 10s. */
  connectTimeoutMs?: number;
  /** The welcome must arrive within this after the socket opens. Default 10s. */
  welcomeTimeoutMs?: number;
  /** Called with every welcome (also after reconnects). */
  onWelcome?: (w: LinkWelcome) => void;
  /** Called with each `grants` frame (the host's registry-granted KB domains changed). */
  onGrants?: (domains: string[]) => void;
  /** Called with each kb.changed hint pushed by the hub. */
  onKbChanged?: (domain: string, rev: number, epoch: string) => void;
  /** Called with the welcome's retired wolf names. */
  onRetired?: (names: string[]) => void;
  /** Command kinds this machine can run, advertised in hello. Absent or empty = none (the hub answers not_sent_unsupported). */
  commands?: () => CommandKind[];
  /** A `cmd` frame arrived from the hub. The returned result is sent back as `cmd.result`; a throw is answered `internal`. */
  onCommand?: (cmd: LinkCmd) => Promise<LinkCmdResult>;
  /** The cmd.result was written to the socket (or could not be). workerd.restart exits from here. */
  onCommandSent?: (cmd: LinkCmd, result: LinkCmdResult) => void;
  /** Called with the welcome's rejected wolf names (unknown to the hub, or owned by another host). */
  onRejected?: (names: string[]) => void;
  /** Relay: called for `req` / `cancel` / `pause` / `resume` frames from the hub. */
  onRelay?: (f: Extract<LinkFrame, { t: "req" | "cancel" | "pause" | "resume" }>) => void;
  /** Relay: called when the live socket closes or is retired (in-flight relayed requests must stop). */
  onLinkDown?: () => void;
  /** Called with the welcome's domain mismatches (informational; the hub registry decides domains). */
  onDomainMismatch?: (m: { wolf: string; reported: string[]; granted: string[] }[]) => void;
  /** Durable contribution outbox. Items are sent on every (re)connect and removed when the hub acks them. */
  outbox?: Outbox;
  /** A receipt arrived. Must write it durably; the receipt.ack is sent only if this returns without throwing. */
  onReceipt?: (r: LinkReceipt) => void;
  /** A contribution was terminally rejected by the hub (kept under outbox/rejected). */
  onContributionRejected?: (id: string, code: string | undefined, message: string | undefined) => void;
  /** Resend an unacknowledged contribution after this long while online, ms. Default 15000. */
  ackTimeoutMs?: number;
  /** Contributions sent but not yet acknowledged at once. Default 32. */
  sendWindow?: number;
  /** Retry backoff for `internal` / `foreign_wolf` acks: base * 2^tries, capped at 60s. Default base 1000 ms. */
  retryBaseMs?: number;
  /** `foreign_wolf` rejections retried before the item is dead-lettered. Default 3. */
  foreignRetries?: number;
  /** `internal` / unknown-code rejections retried before the item is parked. Default MAX_ITEM_RETRIES. */
  maxItemRetries?: number;
  /** Reconnect interval while the hub says "incompatible", ms. Default 15 min. */
  incompatibleRetryMs?: number;
  /** Reconnect interval (+-20% jitter) while another workerd holds this host id ("replaced"), ms. Default 30 min. */
  replacedRetryMs?: number;
  /** A parked item is not retried again sooner than this after the welcome that unparks it, ms. Default 60 s. */
  parkedRetryMs?: number;
}

/** Automatic retries of an item the hub answers `internal` (or an unknown code) before it is parked in the outbox. */
export const MAX_ITEM_RETRIES = 10;
/** Reconnect interval while the hub is protocol-incompatible: retrying every minute cannot fix it. */
export const INCOMPATIBLE_RETRY_MS = 15 * 60_000;
/** Reconnect interval while another workerd holds this host id: fighting for the link every minute helps nobody, but a short-lived replacer must not strand us. */
export const REPLACED_RETRY_MS = 30 * 60_000;
/** Floor between welcomes and the one extra try of a parked item, so a hub that reconnects every few seconds cannot make a poison item retry on every connect. */
export const PARKED_RETRY_MS = 60_000;

export interface LinkStatus {
  state: LinkState;
  /** Human text for incompatible / unauthorized / errors. */
  detail?: string;
  attempts: number;
  nextRetryInMs: number | null;
  /** Outbox items given up on for automatic retry (still queued on disk). Memory-only: the count resets to 0 on restart, and every parked item then gets one more try.
   *  While running, each is retried once per welcome, no sooner than parkedRetryMs (60 s) after it. */
  parked: number;
}

/** 1s, 2s, 4s ... capped at 60s, each +-20% (the cap is a hard ceiling, jitter included). `failures` is the consecutive failure count (>= 1). */
export function linkBackoff(failures: number, rand: () => number, baseMs = 1000, capMs = 60_000): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.min(capMs, Math.round(raw * (0.8 + 0.4 * rand())));
}

export class HubLink {
  private ws: WebSocket | null = null;
  private st: LinkState = "idle";
  private detail?: string;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private deadTimer: NodeJS.Timeout | null = null;
  private welcomeTimer: NodeJS.Timeout | null = null;
  private retryAt: number | null = null;
  private stopped = false;
  private heartbeatDeadMs = 0;
  private sentWolves = new Map<string, string>();
  private inflight = new Map<string, number>();
  /** Per-item retry state after a non-terminal rejection (in memory; a restart starts over). */
  private retry = new Map<string, { tries: number; foreign: number; notBefore: number }>();
  /** Items that used up their retries: kept in the outbox, not sent again until a reconnect gives them one more try. */
  private parked = new Set<string>();
  private resendTimer: NodeJS.Timeout | null = null;
  private readonly laptop: boolean;
  private readonly rand: () => number;

  constructor(private readonly o: HubLinkOptions) {
    this.laptop = o.laptop ?? process.platform === "darwin";
    this.rand = o.rand ?? Math.random;
  }

  status(): LinkStatus {
    return { state: this.st, ...(this.detail ? { detail: this.detail } : {}), attempts: this.failures, nextRetryInMs: this.retryAt === null ? null : Math.max(0, this.retryAt - Date.now()), parked: this.parked.size };
  }
  private log(m: string) {
    (this.o.log ?? (() => {}))(`[workerd] hub link: ${m}`);
  }
  private sticky(): boolean {
    return STICKY.has(this.st);
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Reconnect now (wake / network change): says bye on a live socket, skips any backoff wait. A "replaced" link stays put: it only retries on its slow replacedRetryMs timer. */
  kick(): void {
    if (this.stopped || this.st === "replaced") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.retryAt = null;
    const old = this.ws;
    this.ws = null;
    if (old) this.retire(old);
    this.failures = 0;
    this.connect();
  }

  /** Clean shutdown: say bye, close 1000. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.st = "stopped";
    this.clearTimers();
    this.retryAt = null;
    const ws = this.ws;
    this.ws = null;
    this.o.onLinkDown?.();
    if (!ws) return;
    await new Promise<void>((resolve) => {
      const fin = setTimeout(resolve, 1000);
      ws.once("close", () => (clearTimeout(fin), resolve()));
      this.bye(ws, () => resolve());
    });
  }

  /** Tell the hub the machine is about to sleep (when the OS gives notice). */
  sendSleep(): void {
    this.send({ t: "sleep" });
  }
  /** Send any frame on the live link (relay answers). False when not online. */
  sendFrame(f: LinkFrame, written?: (err?: Error) => void): boolean {
    if (this.st === "online" && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeLinkFrame(f), (err) => written?.(err));
      return true;
    }
    return false;
  }
  wolfAdded(w: LinkWolf): void {
    if (this.send({ t: "wolf.add", wolf: w })) this.sentWolves.set(w.name, JSON.stringify(w.domains));
  }
  wolfRemoved(name: string): void {
    if (this.send({ t: "wolf.remove", name })) this.sentWolves.delete(name);
  }

  /** Queue a contribution durably (idempotency id generated unless given) and send it now if the link is up. Throws OutboxError when too large/full. */
  contribute(wolf: string, contribution: Record<string, unknown>, id?: string): string {
    if (!this.o.outbox) throw new Error("no outbox configured");
    const item = this.o.outbox.enqueue(wolf, contribution, id);
    this.flushOutbox();
    return item.id;
  }

  /** Send outbox items (oldest first) while fewer than `sendWindow` are awaiting an ack; skip those backing off. */
  private flushOutbox(): void {
    if (!this.o.outbox || this.st !== "online") return;
    const now = Date.now();
    const timeout = this.o.ackTimeoutMs ?? 15_000;
    const window = this.o.sendWindow ?? 32;
    let awaiting = 0;
    for (const [id, at] of this.inflight) {
      if (now - at >= timeout) this.inflight.delete(id); // overdue: eligible to resend
      else awaiting++;
    }
    for (const it of this.o.outbox.list()) {
      if (awaiting >= window) break;
      if (this.inflight.has(it.id)) continue;
      if (this.parked.has(it.id)) continue;
      if ((this.retry.get(it.id)?.notBefore ?? 0) > now) continue;
      if (this.send({ t: "contribute", id: it.id, wolf: it.wolf, contribution: it.contribution })) {
        this.inflight.set(it.id, now);
        awaiting++;
      }
    }
  }

  /** A non-terminal rejection: keep the item and try again later. */
  private backoffItem(id: string, foreign: boolean): number {
    const r = this.retry.get(id) ?? { tries: 0, foreign: 0, notBefore: 0 };
    r.tries++;
    if (foreign) r.foreign++;
    r.notBefore = Date.now() + linkBackoff(r.tries, this.rand, this.o.retryBaseMs ?? 1000);
    this.retry.set(id, r);
    if (!foreign && r.tries >= (this.o.maxItemRetries ?? MAX_ITEM_RETRIES)) {
      this.parked.add(id);
      this.log(`contribution ${JSON.stringify(id.slice(0, 64))} parked after ${r.tries} failed attempts; it stays in the outbox and is retried once after the next reconnect (${this.parked.size} parked)`);
    }
    return r.foreign;
  }

  private terminal(id: string, code: string | undefined, message: string | undefined): void {
    this.log(`hub rejected contribution ${JSON.stringify(id.slice(0, 64))}: ${code ?? "?"} ${message ?? ""}`);
    this.o.outbox?.reject(id, `${code ?? "rejected"}: ${message ?? ""}`); // throws (item stays queued) if the dead letter cannot be made durable
    this.retry.delete(id);
    this.parked.delete(id);
    this.o.onContributionRejected?.(id, code ?? "rejected", message);
  }

  private clearTimers(): void {
    if (this.resendTimer) clearInterval(this.resendTimer);
    this.resendTimer = null;
    for (const k of ["timer", "deadTimer", "welcomeTimer"] as const) {
      if (this[k]) clearTimeout(this[k]!);
      this[k] = null;
    }
  }

  private send(f: LinkFrame): boolean {
    if (this.st === "online" && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(encodeLinkFrame(f));
      return true;
    }
    return false;
  }

  /** Goodbye on a socket we are leaving: bye frame + close 1000. */
  private bye(ws: WebSocket, onError?: () => void): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(encodeLinkFrame({ t: "bye" }));
        ws.close(1000, "bye");
      } else ws.terminate();
    } catch {
      onError?.();
    }
  }
  private retire(ws: WebSocket): void {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.deadTimer = this.welcomeTimer = null;
    ws.removeAllListeners("message");
    ws.on("error", () => {});
    this.o.onLinkDown?.();
    this.bye(ws);
  }

  private connect(): void {
    if (this.stopped || this.ws) return;
    if (!this.sticky()) this.st = "connecting";
    const url = this.o.hubUrl.replace(/^http/i, "ws").replace(/\/+$/, "") + LINK_PATH;
    const Impl = this.o.WebSocketImpl ?? WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(url, { headers: { Authorization: `Bearer ${this.o.token}` }, handshakeTimeout: this.o.connectTimeoutMs ?? 10_000 });
    } catch (e) {
      this.fail(String((e as Error).message));
      return;
    }
    this.ws = ws;
    let refused = false;
    ws.on("unexpected-response", (_req, res) => {
      if (this.ws !== ws) return;
      refused = true;
      const code = res.statusCode ?? 0;
      res.resume();
      if (code === 401 || code === 403) {
        this.st = "unauthorized";
        this.detail = code === 401 ? "token rejected or revoked; re-pair with `workerd pair`" : "hub refused this token (not a worker token for this host); re-pair with `workerd pair`";
        this.log(this.detail);
      } else this.detail = `hub answered HTTP ${code}`;
      ws.terminate(); // with an 'unexpected-response' listener ws leaves the socket open; the close handler schedules the retry
    });
    ws.on("open", () => {
      if (this.ws !== ws) return;
      const wolves = this.o.wolves();
      this.sentWolves = new Map(wolves.map((w) => [w.name, JSON.stringify(w.domains)]));
      ws.send(encodeLinkFrame({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId: this.o.hostId, laptop: this.laptop, ...(machineName() ? { machine: machineName() } : {}), wolves, kbRevisions: this.o.kbRevisions?.() ?? {}, ...(this.o.commands?.().length ? { commands: this.o.commands() } : {}) }));
      this.welcomeTimer = setTimeout(() => {
        if (this.ws !== ws) return;
        this.log("no welcome from the hub in time; reconnecting");
        ws.terminate(); // the close handler schedules the retry
      }, this.o.welcomeTimeoutMs ?? 10_000);
      this.welcomeTimer.unref();
    });
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws || isBinary) return;
      this.onFrame(ws, data.toString());
    });
    ws.on("close", (code) => {
      if (this.ws !== ws) return; // retired by kick()/stop()
      this.o.onLinkDown?.();
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      if (code === 4001) {
        this.st = "incompatible";
        this.detail = "hub incompatible";
        this.log(`hub incompatible (link protocol major mismatch); next attempt in ${Math.round((this.o.incompatibleRetryMs ?? INCOMPATIBLE_RETRY_MS) / 60_000)} min (update workerd or the hub)`);
      } else if (code === 4401) {
        this.st = "unauthorized";
        this.detail = "token rejected or revoked; re-pair with `workerd pair`";
        this.log(this.detail);
      } else if (code === 4409) {
        this.st = "replaced";
        this.detail = "replaced by a newer connection from this host id (another workerd with the same host?)";
        this.log(this.detail);
      } else if (!refused && !this.sticky()) this.detail ??= `closed (${code})`;
      this.schedule();
    });
    ws.on("error", (e) => {
      // A failed connect also fires close; remember why for status() (never over a sticky reason).
      if (!this.sticky() && !refused) this.detail = `connection failed: ${(e as Error).message}`.slice(0, 200);
    });
  }

  private onFrame(ws: WebSocket, text: string): void {
    const p = parseLinkFrame(text);
    if (!p.ok) return;
    const f = p.frame;
    if (f.t === "welcome") {
      if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
      this.st = "online";
      this.detail = undefined;
      this.failures = 0;
      this.heartbeatDeadMs = f.deadAfterMs;
      this.log(`online (host ${this.o.hostId})`);
      if (f.retired.length) this.o.onRetired?.(f.retired);
      if (f.rejected.length) {
        this.log(`hub rejected wolves ${f.rejected.map((n) => JSON.stringify(n.slice(0, 64))).join(", ")} (an operator must register or release them)`);
        this.o.onRejected?.(f.rejected);
      }
      if (f.domainMismatch.length) {
        for (const m of f.domainMismatch) this.log(`wolf ${JSON.stringify(m.wolf.slice(0, 64))}: wolf.yaml domains [${m.reported.join(", ")}] differ from the hub's [${m.granted.join(", ")}]; the hub decides`);
        this.o.onDomainMismatch?.(f.domainMismatch);
      }
      this.syncDiff();
      this.o.onWelcome?.(f);
      for (const id of this.parked) {
        const t = this.retry.get(id);
        if (t) {
          t.tries = (this.o.maxItemRetries ?? MAX_ITEM_RETRIES) - 1; // one more attempt; a further failure parks it again
          t.notBefore = Date.now() + (this.o.parkedRetryMs ?? PARKED_RETRY_MS);
        }
      }
      this.parked.clear();
      this.inflight.clear(); // a new connection: everything unacked is replayed (the hub dedups on the idempotency id)
      this.flushOutbox();
      if (this.resendTimer) clearInterval(this.resendTimer);
      this.resendTimer = null;
      if (this.o.outbox) {
        this.resendTimer = setInterval(() => this.flushOutbox(), Math.max(50, Math.floor((this.o.ackTimeoutMs ?? 15_000) / 2)));
        this.resendTimer.unref();
      }
    } else if (f.t === "contribute.ack") {
      this.inflight.delete(f.id);
      try {
        if (f.status !== "rejected") {
          this.retry.delete(f.id);
          this.parked.delete(f.id);
          this.o.outbox?.remove(f.id);
        } else if (f.code === "invalid" || f.code === "too_large") {
          this.terminal(f.id, f.code, f.message);
        } else if (f.code === "foreign_wolf") {
          // Ownership can lag a registry change: retry a few times before giving up.
          if (this.backoffItem(f.id, true) > (this.o.foreignRetries ?? 3)) this.terminal(f.id, f.code, f.message);
          else this.log(`hub says wolf of contribution ${JSON.stringify(f.id.slice(0, 64))} is not on this host; will retry`);
        } else {
          // internal (or an unknown code from a newer hub): NOT terminal; stays in the outbox with backoff.
          this.backoffItem(f.id, false);
          this.log(`hub could not take contribution ${JSON.stringify(f.id.slice(0, 64))} (${f.code ?? "?"}); will retry`);
        }
      } catch (e) {
        this.log(`outbox update for ${JSON.stringify(f.id.slice(0, 64))} failed: ${(e as Error).message}`);
      }
    } else if (f.t === "receipt") {
      try {
        this.o.onReceipt?.(f);
        if (this.o.onReceipt) this.send({ t: "receipt.ack", id: f.id });
      } catch (e) {
        const permanent = (e as { permanent?: boolean }).permanent === true;
        this.log(`could not write receipt ${JSON.stringify(f.name.slice(0, 80))} for ${JSON.stringify(f.wolf.slice(0, 64))}: ${(e as Error).message}${permanent ? " (permanent; acked and dropped)" : ""}`);
        // transient: no ack, the hub resends. Permanent (bad name): ack so the hub records it delivered and stops resending (else it loops forever).
        if (permanent) this.send({ t: "receipt.ack", id: f.id });
      }
    } else if (f.t === "grants") {
      this.o.onGrants?.(f.domains);
    } else if (f.t === "kb.changed") {
      this.o.onKbChanged?.(f.domain, f.rev, f.epoch);
    } else if (f.t === "ping") {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeLinkFrame({ t: "pong", n: f.n }));
    } else if (f.t === "req" || f.t === "cancel" || f.t === "pause" || f.t === "resume") {
      if (this.st === "online") {
        try {
          this.o.onRelay?.(f);
        } catch (e) {
          this.log(`relay handler failed: ${(e as Error).message}`);
        }
      }
    } else if (f.t === "cmd") {
      const h = this.o.onCommand;
      if (h && this.st === "online") {
        void h(f)
          .catch((): LinkCmdResult => ({ t: "cmd.result", id: f.id, ok: false, code: "internal", message: "the command failed" }))
          .then((r) => {
            if (!this.sendFrame(r, (err) => !err && this.o.onCommandSent?.(f, r))) return; // link dropped: the hub resolves it not_sent_offline
          });
      }
    } else if (f.t === "error") {
      // Never overwrite a sticky reason; a rejected wolf.add is informational.
      if (!this.sticky() && f.code !== "rejected") this.detail = f.message ? `${f.code}: ${f.message}` : f.code;
      if (f.code === "rejected") this.log(`hub: ${f.message ?? "rejected"}`);
    }
    if (this.st === "online" && this.heartbeatDeadMs) {
      if (this.deadTimer) clearTimeout(this.deadTimer);
      this.deadTimer = setTimeout(() => {
        this.log("hub silent past the dead-after window; reconnecting");
        if (this.ws === ws) ws.terminate(); // close handler schedules the retry
      }, this.heartbeatDeadMs);
      this.deadTimer.unref();
    }
  }

  /** Wolves added/removed between the hello snapshot and the welcome were not sent as frames: send the difference now. */
  private syncDiff(): void {
    const now = new Map(this.o.wolves().map((w) => [w.name, w] as const));
    for (const [name, w] of now) {
      if (this.sentWolves.get(name) !== JSON.stringify(w.domains)) this.wolfAdded(w);
    }
    for (const name of [...this.sentWolves.keys()]) if (!now.has(name)) this.wolfRemoved(name);
  }

  private fail(detail: string): void {
    if (!this.sticky()) this.detail = detail;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.failures += 1;
    if (this.st === "replaced") {
      // Another workerd with this host id took over. Retry slowly (+-20%): with two live workerds the link changes hands at most about twice an hour,
      // and a short-lived replacer (dev run, sleeping laptop) does not strand this one until a restart. kick() does not bypass this.
      const delay = Math.round((this.o.replacedRetryMs ?? REPLACED_RETRY_MS) * (0.8 + 0.4 * this.rand()));
      this.retryAt = Date.now() + delay;
      this.log(`replaced by another connection from this host id; next attempt at ${new Date(this.retryAt).toISOString()} (in ${Math.round(delay / 60_000)} min)`);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.retryAt = null;
        this.connect();
      }, delay);
      this.timer.unref();
      return;
    }
    const cap = this.o.capMs ?? 60_000;
    // Sticky reasons retry at the cap; the failure count keeps growing across them.
    // incompatible: the protocol will not fix itself, so wait long; unauthorized keeps retrying at the cap (a re-pair fixes it without a restart).
    const delay = this.st === "incompatible" ? (this.o.incompatibleRetryMs ?? INCOMPATIBLE_RETRY_MS) : this.sticky() ? linkBackoff(Number.MAX_SAFE_INTEGER, this.rand, this.o.baseMs, cap) : linkBackoff(this.failures, this.rand, this.o.baseMs, cap);
    if (!this.sticky()) this.st = "backoff";
    this.retryAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.retryAt = null;
      this.connect();
    }, delay);
    this.timer.unref();
  }
}
