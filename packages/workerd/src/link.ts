/**
 * HubLink: workerd's single WebSocket to the hub (GET /v1/link). Opens with `hello`, reports wolves added/removed, answers pings,
 * reconnects with backoff 1s -> 60s (+-20% jitter, never above the cap) and at once on kick() (wake / network change).
 *
 * Uses the `ws` client (not the global WebSocket) because only `ws` exposes the HTTP status of a refused upgrade (401/403).
 * "unauthorized", "incompatible" and "replaced" are sticky: the state and detail survive retries (made at the cap, or a long delay
 * for "replaced") until a welcome arrives.
 */
import WebSocket from "ws";
import { LINK_PATH, LINK_PROTOCOL_VERSION, encodeLinkFrame, parseLinkFrame, type LinkFrame, type LinkWolf } from "@wolfpack/protocol";

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
  /** Called with the welcome's retired wolf names. */
  onRetired?: (names: string[]) => void;
  /** Called with the welcome's rejected wolf names (unknown to the hub, or owned by another host). */
  onRejected?: (names: string[]) => void;
  /** Called with the welcome's domain mismatches (informational; the hub registry decides domains). */
  onDomainMismatch?: (m: { wolf: string; reported: string[]; granted: string[] }[]) => void;
}

export interface LinkStatus {
  state: LinkState;
  /** Human text for incompatible / unauthorized / errors. */
  detail?: string;
  attempts: number;
  nextRetryInMs: number | null;
}

/** 1s, 2s, 4s ... capped at 60s, each +-20% (the cap is a hard ceiling, jitter included). `failures` is the consecutive failure count (>= 1). */
export function linkBackoff(failures: number, rand: () => number, baseMs = 1000, capMs = 60_000): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.min(capMs, Math.round(raw * (0.8 + 0.4 * rand())));
}

const REPLACED_DELAY_FACTOR = 1; // replaced: retry at the cap (a long delay), so two workerds with one host id do not fight

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
  private readonly laptop: boolean;
  private readonly rand: () => number;

  constructor(private readonly o: HubLinkOptions) {
    this.laptop = o.laptop ?? process.platform === "darwin";
    this.rand = o.rand ?? Math.random;
  }

  status(): LinkStatus {
    return { state: this.st, ...(this.detail ? { detail: this.detail } : {}), attempts: this.failures, nextRetryInMs: this.retryAt === null ? null : Math.max(0, this.retryAt - Date.now()) };
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

  /** Reconnect now (wake / network change): says bye on a live socket, skips any backoff wait. A "replaced" link stays put. */
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
  wolfAdded(w: LinkWolf): void {
    if (this.send({ t: "wolf.add", wolf: w })) this.sentWolves.set(w.name, JSON.stringify(w.domains));
  }
  wolfRemoved(name: string): void {
    if (this.send({ t: "wolf.remove", name })) this.sentWolves.delete(name);
  }

  private clearTimers(): void {
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
      ws.send(encodeLinkFrame({ t: "hello", v: LINK_PROTOCOL_VERSION, hostId: this.o.hostId, laptop: this.laptop, wolves, kbRevisions: this.o.kbRevisions?.() ?? {} }));
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
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      if (code === 4001) {
        this.st = "incompatible";
        this.detail = "hub incompatible";
        this.log("hub incompatible (link protocol major mismatch); will keep retrying");
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
      this.syncDiff(ws);
    } else if (f.t === "ping") {
      if (ws.readyState === WebSocket.OPEN) ws.send(encodeLinkFrame({ t: "pong", n: f.n }));
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
  private syncDiff(ws: WebSocket): void {
    const now = new Map(this.o.wolves().map((w) => [w.name, w] as const));
    for (const [name, w] of now) {
      if (this.sentWolves.get(name) !== JSON.stringify(w.domains)) this.wolfAdded(w);
    }
    for (const name of [...this.sentWolves.keys()]) if (!now.has(name)) this.wolfRemoved(name);
    void ws;
  }

  private fail(detail: string): void {
    if (!this.sticky()) this.detail = detail;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.failures += 1;
    const cap = this.o.capMs ?? 60_000;
    // Sticky reasons retry at the cap; the failure count keeps growing across them.
    const delay = this.sticky() ? linkBackoff(Number.MAX_SAFE_INTEGER, this.rand, this.o.baseMs, cap) * REPLACED_DELAY_FACTOR : linkBackoff(this.failures, this.rand, this.o.baseMs, cap);
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
