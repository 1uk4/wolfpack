/**
 * Worker link: one WebSocket per host on GET /v1/link. Authenticates BEFORE upgrading (worker token with a hostId only; the legacy
 * key and console/browser tokens are refused), registers the host and its wolves from `hello`, tracks presence
 * (online / asleep / offline), and drops the link when its token is revoked. Relay frames are not handled yet (error bad_frame is
 * NOT sent for them either: they are valid frames, ignored until the relay ticket).
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  LINK_CLOSE,
  LINK_DEAD_AFTER_MS,
  LINK_HEARTBEAT_MS,
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
  const t: LinkTimers = { heartbeatMs: LINK_HEARTBEAT_MS, deadAfterMs: LINK_DEAD_AFTER_MS, helloTimeoutMs: LINK_HELLO_TIMEOUT_MS, ...opts.timers };
  const log = opts.log ?? ((m: string) => console.log(m));
  const wss = new WebSocketServer({ noServer: true, maxPayload: LINK_MAX_PAYLOAD });
  const conns = new Set<Conn>();
  const byHost = new Map<string, Conn>();
  const states = new Map<string, LinkPresence>();
  const listeners = new Set<PresenceListener>();

  const setPresence = (hostId: string, p: LinkPresence) => {
    if ((states.get(hostId) ?? "offline") === p) return;
    states.set(hostId, p);
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
    if (!linkCompatible(h.v)) {
      sendError(c, "version_mismatch", `hub speaks link protocol ${LINK_PROTOCOL_VERSION}, worker sent ${h.v}`);
      return hubClose(c, LINK_CLOSE.incompatible, "incompatible");
    }
    if (h.hostId !== c.hostId) {
      sendError(c, "unauthorized", "hello.hostId does not match the token");
      return hubClose(c, LINK_CLOSE.unauthorized, "unauthorized");
    }
    const old = byHost.get(c.hostId);
    if (old && old !== c) {
      sendError(old, "replaced");
      hubClose(old, LINK_CLOSE.replaced, "replaced");
    }
    byHost.set(c.hostId, c);
    c.hello = h;
    const { retired } = await opts.registry.applyHello(c.hostId, h.wolves);
    if (c.ws.readyState !== c.ws.OPEN || byHost.get(c.hostId) !== c) return;
    send(c, { t: "welcome", v: LINK_PROTOCOL_VERSION, heartbeatMs: t.heartbeatMs, deadAfterMs: t.deadAfterMs, retired, hubRevisions: {} });
    setPresence(c.hostId, "online");
    let n = 0;
    c.pingTimer = setInterval(() => send(c, { t: "ping", n: ++n }), t.heartbeatMs);
    c.pingTimer.unref();
    armDead(c);
  }

  async function onFrame(c: Conn, text: string) {
    const p = parseLinkFrame(text);
    if (!p.ok) return sendError(c, "bad_frame", p.reason);
    const f = p.frame;
    if (!c.hello) {
      if (f.t === "hello") return onHello(c, f);
      return sendError(c, "bad_frame", "hello expected first");
    }
    if (byHost.get(c.hostId) !== c) return;
    armDead(c);
    if (f.t !== "sleep" && c.sleeping) {
      c.sleeping = false;
      setPresence(c.hostId, "online");
    }
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
        if (!(await opts.registry.addWolf(c.hostId, f.wolf))) log(`hubd: link ${c.hostId}: wolf ${f.wolf.name} not registered (retired or invalid)`);
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
    },
    presence: (hostId) => states.get(hostId) ?? "offline",
    onPresence(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    sendToHost(hostId, frame) {
      const c = byHost.get(hostId);
      if (!c || c.ws.readyState !== c.ws.OPEN) return false;
      send(c, frame);
      return true;
    },
    sendToWolf(wolf, frame) {
      try {
        const host = (opts.registry.get("wolves", wolf) as { host?: string }).host;
        return host ? this.sendToHost(host, frame) : false;
      } catch {
        return false;
      }
    },
  };
}
