/**
 * Worker link: one WebSocket per host on GET /v1/link. Authenticates BEFORE upgrading (worker token with a hostId only; the legacy
 * key and console/browser tokens are refused), registers the host and its wolves from `hello`, tracks presence
 * (online / asleep / offline), and drops the link when its token is revoked. Relay frames are valid but not handled yet: they are
 * ignored until the relay ticket (no error is sent for them).
 *
 * Wolves are pre-registered by the operator: a hello/wolf.add can only attach a known, unretired wolf that is unowned or already on
 * this host. Anything else is `rejected` (welcome.rejected / an error frame) and logged; nothing is created.
 * Presence: an asleep host (sleep frame, or clean close of a laptop) stays asleep until it reconnects (heartbeat traffic does not
 * undo it) and turns offline after `asleepOfflineMs` (default 12h).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  LINK_CLOSE,
  LINK_DEAD_AFTER_MS,
  LINK_ASLEEP_OFFLINE_MS,
  LINK_HEARTBEAT_MS,
  LINK_HELLO_MAX_PAYLOAD,
  LINK_HELLO_TIMEOUT_MS,
  LINK_MAX_PAYLOAD,
  LINK_PROTOCOL_VERSION,
  encodeLinkFrame,
  linkCompatible,
  parseLinkFrame,
  type LinkErrorCode,
  type LinkFrame,
  type LinkHello,
  type LinkPresence,
} from "@wolfpack/protocol";
import type { AuthIdentity } from "./auth.js";
import type { Registry } from "./registry.js";

export interface LinkTimers {
  heartbeatMs: number;
  deadAfterMs: number;
  helloTimeoutMs: number;
  /** Asleep -> offline after this long without a reconnect. Default 12h. */
  asleepOfflineMs: number;
}

export interface LinkOptions {
  authenticate: (req: IncomingMessage) => AuthIdentity | null;
  registry: Registry;
  /** @internal TEST-ONLY: shrink the heartbeat / dead / hello timers. */
  timers?: Partial<LinkTimers>;
  log?: (m: string) => void;
}

export type PresenceListener = (hostId: string, presence: LinkPresence) => void;

export interface Link {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Close (4401) every link opened with this token. */
  closeByToken(tokenId: string): void;
  /** Close (4401) the link of this host, if any. */
  closeByHost(hostId: string): void;
  closeAll(): void;
  presence(hostId: string): LinkPresence;
  onPresence(l: PresenceListener): () => void;
  /** Send a frame to the host's live link. False when the host has no live link. */
  sendToHost(hostId: string, frame: LinkFrame): boolean;
  /** Relay stub (next ticket): resolves the wolf's host from the registry and sends. */
  sendToWolf(wolf: string, frame: LinkFrame): boolean;
}

interface Conn {
  ws: WebSocket;
  tokenId: string;
  hostId: string;
  hello?: LinkHello;
  sleeping: boolean;
  bye: boolean;
  /** Why the hub itself closed it (revoke / replaced / shutdown): presence is then decided by that, not by the laptop flag. */
  hubClosed: boolean;
  helloTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
  deadTimer?: NodeJS.Timeout;
  queue: Promise<void>;
}

export function createLink(opts: LinkOptions): Link {
  const t: LinkTimers = { heartbeatMs: LINK_HEARTBEAT_MS, deadAfterMs: LINK_DEAD_AFTER_MS, helloTimeoutMs: LINK_HELLO_TIMEOUT_MS, asleepOfflineMs: LINK_ASLEEP_OFFLINE_MS, ...opts.timers };
  const log = opts.log ?? ((m: string) => console.log(m));
  const wss = new WebSocketServer({ noServer: true, maxPayload: LINK_HELLO_MAX_PAYLOAD });
  const conns = new Set<Conn>();
  const byHost = new Map<string, Conn>();
  const states = new Map<string, LinkPresence>();
  const listeners = new Set<PresenceListener>();
  const asleepTimers = new Map<string, NodeJS.Timeout>();
  const q = (v: unknown) => JSON.stringify(String(v).slice(0, 64)); // log-safe

  const setPresence = (hostId: string, p: LinkPresence) => {
    if ((states.get(hostId) ?? "offline") === p) return;
    states.set(hostId, p);
    clearTimeout(asleepTimers.get(hostId));
    asleepTimers.delete(hostId);
    if (p === "asleep") {
      const tm = setTimeout(() => (asleepTimers.delete(hostId), setPresence(hostId, "offline")), t.asleepOfflineMs);
      tm.unref();
      asleepTimers.set(hostId, tm);
    }
    for (const l of [...listeners]) {
      try {
        l(hostId, p);
      } catch (e) {
        log(`hubd: presence listener failed: ${(e as Error).message}`);
      }
    }
  };
  const send = (c: Conn, f: LinkFrame) => {
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(encodeLinkFrame(f));
  };
  const sendError = (c: Conn, code: LinkErrorCode, message?: string) => send(c, { t: "error", code, ...(message ? { message } : {}) });
  const clearTimers = (c: Conn) => {
    clearTimeout(c.helloTimer);
    clearInterval(c.pingTimer);
    clearTimeout(c.deadTimer);
  };
  const hubClose = (c: Conn, code: number, reason: string) => {
    c.hubClosed = true;
    try {
      c.ws.close(code, reason);
    } catch {
      /* already closing */
    }
    // A peer that never answers the close handshake must not linger.
    setTimeout(() => c.ws.terminate(), 2000).unref();
  };
  const armDead = (c: Conn) => {
    clearTimeout(c.deadTimer);
    c.deadTimer = setTimeout(() => {
      log(`hubd: link ${c.hostId}: no heartbeat for ${t.deadAfterMs}ms; dropping`);
      c.ws.terminate();
    }, t.deadAfterMs);
    c.deadTimer.unref();
  };

  function onClose(c: Conn, code: number) {
    clearTimers(c);
    conns.delete(c);
    if (byHost.get(c.hostId) !== c) return; // replaced or never registered: presence belongs to the newer link
    byHost.delete(c.hostId);
    const laptop = c.hello?.laptop ?? false;
    const asleep = !c.hubClosed && (c.sleeping || ((code === 1000 || c.bye) && laptop));
    setPresence(c.hostId, asleep ? "asleep" : "offline");
  }

  async function onHello(c: Conn, h: LinkHello) {
    clearTimeout(c.helloTimer);
    if (!linkCompatible(h.v)) return versionMismatch(c, h.v);
    if (h.hostId !== c.hostId) {
      sendError(c, "unauthorized", "hello.hostId does not match the token");
      return hubClose(c, LINK_CLOSE.unauthorized, "unauthorized");
    }
    // Register FIRST: if that fails the existing connection (if any) stays untouched and this one is dropped.
    let result: { retired: string[]; rejected: string[]; domainMismatch: { wolf: string; reported: string[]; granted: string[] }[] };
    try {
      result = await opts.registry.applyHello(c.hostId, h.wolves);
    } catch (e) {
      log(`hubd: link ${c.hostId}: registering hello failed: ${(e as Error).message}`);
      sendError(c, "internal", "could not register this host");
      return hubClose(c, 1011, "register failed");
    }
    if (c.ws.readyState !== c.ws.OPEN) return;
    const old = byHost.get(c.hostId);
    if (old && old !== c) {
      sendError(old, "replaced");
      hubClose(old, LINK_CLOSE.replaced, "replaced");
    }
    byHost.set(c.hostId, c);
    c.hello = h;
    // Hello accepted: now allow full-size frames (ws keeps the limit on the receiver; there is no public setter).
    const receiver = (c.ws as unknown as { _receiver?: { _maxPayload: number } })._receiver;
    if (receiver) receiver._maxPayload = LINK_MAX_PAYLOAD;
    if (result.rejected.length) log(`hubd: link ${c.hostId}: rejected wolves ${result.rejected.map(q).join(", ")}`);
    send(c, { t: "welcome", v: LINK_PROTOCOL_VERSION, heartbeatMs: t.heartbeatMs, deadAfterMs: t.deadAfterMs, retired: result.retired, rejected: result.rejected, domainMismatch: result.domainMismatch, hubRevisions: {} });
    setPresence(c.hostId, "online");
    let n = 0;
    c.pingTimer = setInterval(() => send(c, { t: "ping", n: ++n }), t.heartbeatMs);
    c.pingTimer.unref();
    armDead(c);
  }

  function versionMismatch(c: Conn, v: unknown) {
    clearTimeout(c.helloTimer);
    sendError(c, "version_mismatch", `hub speaks link protocol ${LINK_PROTOCOL_VERSION}, worker sent ${String(v).slice(0, 12)}`);
    hubClose(c, LINK_CLOSE.incompatible, "incompatible");
  }

  async function onFrame(c: Conn, text: string) {
    if (!c.hello) {
      // Version check before the full parse, so a future hello shape still gets "hub incompatible".
      try {
        const raw = JSON.parse(text) as { t?: unknown; v?: unknown };
        if (raw && raw.t === "hello" && typeof raw.v === "number" && !linkCompatible(raw.v)) return versionMismatch(c, raw.v);
      } catch {
        /* fall through to the normal parse error */
      }
    }
    const p = parseLinkFrame(text);
    if (!p.ok) return sendError(c, "bad_frame", p.reason);
    const f = p.frame;
    if (!c.hello) {
      if (f.t === "hello") return onHello(c, f);
      return sendError(c, "bad_frame", "hello expected first");
    }
    if (byHost.get(c.hostId) !== c) return;
    armDead(c);
    switch (f.t) {
      case "hello":
        return sendError(c, "bad_frame", "duplicate hello");
      case "ping":
        return send(c, { t: "pong", n: f.n });
      case "sleep":
        c.sleeping = true;
        return setPresence(c.hostId, "asleep");
      case "bye":
        c.bye = true;
        return;
      case "wolf.add":
        {
          const r = await opts.registry.addWolf(c.hostId, f.wolf);
          if (r !== "ok") {
            log(`hubd: link ${c.hostId}: wolf ${q(f.wolf.name)} not registered (${r})`);
            sendError(c, "rejected", `${f.wolf.name}: ${r}`);
          }
        }
        return;
      case "wolf.remove":
        return opts.registry.removeWolf(c.hostId, f.name);
      default:
        return; // pong, and relay frames (next ticket): nothing to do
    }
  }

  function connect(ws: WebSocket, id: AuthIdentity & { tokenId: string; hostId: string }) {
    const c: Conn = { ws, tokenId: id.tokenId, hostId: id.hostId, sleeping: false, bye: false, hubClosed: false, queue: Promise.resolve() };
    conns.add(c);
    c.helloTimer = setTimeout(() => hubClose(c, LINK_CLOSE.noHello, "no hello"), t.helloTimeoutMs);
    c.helloTimer.unref();
    ws.on("message", (data, isBinary) => {
      if (!c.hello && (data as Buffer).length > LINK_HELLO_MAX_PAYLOAD) return hubClose(c, 1009, "too big");
      if (isBinary) return sendError(c, "bad_frame", "text frames only");
      const text = data.toString();
      c.queue = c.queue.then(() => onFrame(c, text)).catch((e) => log(`hubd: link ${c.hostId}: frame failed: ${(e as Error).message}`));
    });
    ws.on("close", (code) => onClose(c, code));
    ws.on("error", () => {});
  }

  const reject = (socket: Duplex, status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };

  function sendToHost(hostId: string, frame: LinkFrame): boolean {
    const c = byHost.get(hostId);
    if (!c || c.ws.readyState !== c.ws.OPEN) return false;
    send(c, frame);
    return true;
  }

  return {
    handleUpgrade(req, socket, head) {
      socket.on("error", () => {});
      const id = opts.authenticate(req);
      if (!id) return reject(socket, "401 Unauthorized");
      if (id.legacy || id.kind !== "worker" || !id.hostId || !id.tokenId) return reject(socket, "403 Forbidden");
      const ident = id as AuthIdentity & { tokenId: string; hostId: string };
      wss.handleUpgrade(req, socket, head, (ws) => connect(ws, ident));
    },
    closeByToken(tokenId) {
      for (const c of [...conns]) {
        if (c.tokenId !== tokenId) continue;
        sendError(c, "unauthorized", "token revoked");
        hubClose(c, LINK_CLOSE.unauthorized, "revoked");
      }
    },
    closeByHost(hostId) {
      for (const c of [...conns]) {
        if (c.hostId !== hostId) continue;
        sendError(c, "unauthorized");
        hubClose(c, LINK_CLOSE.unauthorized, "closed");
      }
    },
    closeAll() {
      for (const c of [...conns]) hubClose(c, 1001, "hub shutting down");
      for (const c of [...conns]) setTimeout(() => c.ws.terminate(), 200).unref();
      for (const tm of asleepTimers.values()) clearTimeout(tm);
      asleepTimers.clear();
      wss.close();
    },
    presence: (hostId) => states.get(hostId) ?? "offline",
    onPresence(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    sendToHost,
    sendToWolf(wolf, frame) {
      try {
        const host = (opts.registry.get("wolves", wolf) as { host?: string }).host;
        return host ? sendToHost(host, frame) : false;
      } catch {
        return false;
      }
    },
  };
}
