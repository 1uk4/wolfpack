/**
 * HubLink: workerd's single WebSocket to the hub (GET /v1/link). Opens with `hello`, reports wolves added/removed, answers pings,
 * reconnects with backoff 1s -> 60s (+-20% jitter) and at once on kick() (wake / network change).
 */
import { LINK_PATH, LINK_PROTOCOL_VERSION, encodeLinkFrame, parseLinkFrame, type LinkFrame, type LinkWolf } from "@wolfpack/protocol";

export type LinkState = "idle" | "connecting" | "online" | "backoff" | "incompatible" | "unauthorized" | "stopped";

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
  /** Called with the welcome's retired wolf names. */
  onRetired?: (names: string[]) => void;
}

export interface LinkStatus {
  state: LinkState;
  /** Human text for incompatible / unauthorized / errors. */
  detail?: string;
  attempts: number;
  nextRetryInMs: number | null;
}

/** 1s, 2s, 4s ... capped at 60s, each +-20%. `failures` is the consecutive failure count (>= 1). */
export function linkBackoff(failures: number, rand: () => number, baseMs = 1000, capMs = 60_000): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, failures - 1));
  return Math.round(raw * (0.8 + 0.4 * rand()));
}

export class HubLink {
  private ws: WebSocket | null = null;
  private st: LinkState = "idle";
  private detail?: string;
  private failures = 0;
  private timer: NodeJS.Timeout | null = null;
  private deadTimer: NodeJS.Timeout | null = null;
  private retryAt: number | null = null;
  private stopped = false;
  private heartbeatDeadMs = 0;
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

  start(): void {
    this.stopped = false;
    this.connect();
  }

  /** Reconnect now (wake / network change): drops a live socket and skips any backoff wait. */
  kick(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.retryAt = null;
    const old = this.ws;
    this.ws = null;
    if (old) this.discard(old);
    this.failures = 0;
    this.connect();
  }

  /** Clean shutdown: say bye, close 1000. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.st = "stopped";
    if (this.timer) clearTimeout(this.timer);
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.timer = this.deadTimer = null;
    this.retryAt = null;
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    await new Promise<void>((resolve) => {
      const fin = setTimeout(resolve, 1000);
      ws.addEventListener("close", () => (clearTimeout(fin), resolve()));
      try {
        if (ws.readyState === 1) {
          ws.send(encodeLinkFrame({ t: "bye" }));
          ws.close(1000, "bye");
        } else ws.close();
      } catch {
        resolve();
      }
    });
  }

  /** Tell the hub the machine is about to sleep (when the OS gives notice). */
  sendSleep(): void {
    this.send({ t: "sleep" });
  }
  wolfAdded(w: LinkWolf): void {
    this.send({ t: "wolf.add", wolf: w });
  }
  wolfRemoved(name: string): void {
    this.send({ t: "wolf.remove", name });
  }

  private send(f: LinkFrame): void {
    if (this.st === "online" && this.ws?.readyState === 1) this.ws.send(encodeLinkFrame(f));
  }

  private discard(ws: WebSocket): void {
    if (this.deadTimer) clearTimeout(this.deadTimer);
    this.deadTimer = null;
    try {
      ws.close();
    } catch {
      /* closing */
    }
  }

  private connect(): void {
    if (this.stopped || this.ws) return;
    this.st = "connecting";
    const url = this.o.hubUrl.replace(/^http/i, "ws").replace(/\/+$/, "") + LINK_PATH;
    const Impl = (this.o.WebSocketImpl ?? WebSocket) as unknown as new (u: string, o: { headers: Record<string, string> }) => WebSocket;
    let ws: WebSocket;
    try {
      ws = new Impl(url, { headers: { Authorization: `Bearer ${this.o.token}` } });
    } catch (e) {
      this.fail(String((e as Error).message));
      return;
    }
    this.ws = ws;
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.send0(ws, {
        t: "hello",
        v: LINK_PROTOCOL_VERSION,
        hostId: this.o.hostId,
        laptop: this.laptop,
        wolves: this.o.wolves(),
        kbRevisions: this.o.kbRevisions?.() ?? {},
      });
    });
    ws.addEventListener("message", (ev) => {
      if (this.ws !== ws || typeof ev.data !== "string") return;
      this.onFrame(ws, ev.data);
    });
    ws.addEventListener("close", (ev) => {
      if (this.ws !== ws) return; // discarded by kick()/stop()
      this.ws = null;
      if (this.deadTimer) clearTimeout(this.deadTimer);
      this.deadTimer = null;
      if (this.stopped) return;
      const code = (ev as CloseEvent).code;
      if (code === 4001) {
        this.st = "incompatible";
        this.detail = "hub incompatible";
        this.log("hub incompatible (link protocol major mismatch); will keep retrying");
      } else if (code === 4401) {
        this.st = "unauthorized";
        this.detail = "token rejected or revoked; re-pair with `workerd pair`";
        this.log(this.detail);
      } else if (code === 4409) this.detail = "replaced by a newer connection from this host";
      this.schedule();
    });
    ws.addEventListener("error", () => {
      // A failed connect also fires close; remember why for status().
      if (this.st === "connecting") this.detail = "connection failed";
    });
  }

  private send0(ws: WebSocket, f: LinkFrame) {
    if (ws.readyState === 1) ws.send(encodeLinkFrame(f));
  }

  private onFrame(ws: WebSocket, text: string): void {
    const p = parseLinkFrame(text);
    if (!p.ok) return;
    const f = p.frame;
    if (f.t === "welcome") {
      this.st = "online";
      this.detail = undefined;
      this.failures = 0;
      this.heartbeatDeadMs = f.deadAfterMs;
      this.log(`online (host ${this.o.hostId})`);
      if (f.retired.length) this.o.onRetired?.(f.retired);
    } else if (f.t === "ping") this.send0(ws, { t: "pong", n: f.n });
    else if (f.t === "error") this.detail = f.message ? `${f.code}: ${f.message}` : f.code;
    if (this.st === "online" && this.heartbeatDeadMs) {
      if (this.deadTimer) clearTimeout(this.deadTimer);
      this.deadTimer = setTimeout(() => {
        this.log("hub silent past the dead-after window; reconnecting");
        if (this.ws === ws) {
          this.ws = null;
          this.discard(ws);
          this.fail("hub silent");
        }
      }, this.heartbeatDeadMs);
      this.deadTimer.unref();
    }
  }

  private fail(detail: string): void {
    this.detail = detail;
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped) return;
    this.failures += 1;
    const delay = linkBackoff(this.failures, this.rand, this.o.baseMs, this.o.capMs);
    if (this.st === "connecting" || this.st === "online") this.st = "backoff";
    this.retryAt = Date.now() + delay;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.retryAt = null;
      this.connect();
    }, delay);
    this.timer.unref();
  }
}
