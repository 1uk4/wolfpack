/**
 * Worker link: one WebSocket per host on GET /v1/link. Authenticates BEFORE upgrading (worker token with a hostId only; console/browser
 * tokens are refused), registers the host and its wolves from `hello`, tracks presence
 * (online / asleep / offline), and drops the link when its token is revoked. Relay frames from the worker (res/chunk/end/rerr) are
 * handed to `onRelayFrame` (relay.ts); `onDown` fires when a registered link closes, so in-flight relayed requests fail.
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
  LINK_RELAY_HEAD_TIMEOUT_MS,
  encodeLinkFrame,
  linkCompatible,
  parseLinkFrame,
  type LinkErrorCode,
  type LinkFrame,
  type LinkHello,
  type LinkContribute,
  type LinkContributeAck,
  type LinkPresence,
} from "@wolfpack/protocol";
import { normaliseMachine } from "@wolfpack/protocol/health-lag";
import type { AuthIdentity } from "./auth.js";
import type { Registry } from "./registry.js";

export interface LinkTimers {
  heartbeatMs: number;
  deadAfterMs: number;
  helloTimeoutMs: number;
  /** Asleep -> offline after this long without a reconnect. Default 12h. */
  asleepOfflineMs: number;
  /** Relay: how long a tunnelled request may wait for the worker's `res` head. Default LINK_RELAY_HEAD_TIMEOUT_MS. */
  relayHeadTimeoutMs: number;
}

export interface LinkOptions {
  authenticate: (req: IncomingMessage) => AuthIdentity | null;
  registry: Registry;
  /** @internal TEST-ONLY: shrink the heartbeat / dead / hello timers. */
  timers?: Partial<LinkTimers>;
  log?: (m: string) => void;
  /** Contribution / receipt handlers (link-contributions.ts). Without them those frames are ignored. */
  contributions?: {
    onContribute: (hostId: string, f: LinkContribute) => LinkContributeAck | Promise<LinkContributeAck>;
    onReceiptAck: (hostId: string, id: string) => void;
  };
  /** A relay frame (res/chunk/end/rerr) arrived from a registered host's live link. */
  onRelayFrame?: (hostId: string, epoch: number, frame: LinkFrame) => void;
  /** A registered link (identified by its epoch) closed, for whatever reason (including being replaced). */
  onDown?: (hostId: string, epoch: number) => void;
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
  /**
   * Hint every connected host with a non-retired wolf subscribed to `domain` (per the registry) that the domain moved to `rev`.
   * Returns the host ids notified. Hosts outside the union never get the frame.
   */
  pushKbChanged(domain: string, rev: number, epoch: string): string[];
  /** Resolves the wolf's host from the registry and sends. */
  sendToWolf(wolf: string, frame: LinkFrame): boolean;
  /** Identity of the host's live link (changes on every reconnect); undefined when there is none. */
  epoch(hostId: string): number | undefined;
  /** The machine the host last reported in its hello (kept while it is offline); undefined for an older worker. */
  machine(hostId: string): string | undefined;
  readonly relayHeadTimeoutMs: number;
}

interface Conn {
  ws: WebSocket;
  tokenId: string;
  hostId: string;
  hello?: LinkHello;
  sleeping: boolean;
  /** Last time a frame other than ping/pong/sleep arrived (ms), 0 = never. */
  activeAt: number;
  /** When the sleep frame arrived (ms). */
  sleptAt: number;
  bye: boolean;
  /** Why the hub itself closed it (revoke / replaced / shutdown): presence is then decided by that, not by the laptop flag. */
  hubClosed: boolean;
  helloTimer?: NodeJS.Timeout;
  pingTimer?: NodeJS.Timeout;
  deadTimer?: NodeJS.Timeout;
  queue: Promise<void>;
  epoch: number;
  downNotified?: boolean;
}

export function createLink(opts: LinkOptions): Link {
  const t: LinkTimers = { heartbeatMs: LINK_HEARTBEAT_MS, deadAfterMs: LINK_DEAD_AFTER_MS, helloTimeoutMs: LINK_HELLO_TIMEOUT_MS, asleepOfflineMs: LINK_ASLEEP_OFFLINE_MS, relayHeadTimeoutMs: LINK_RELAY_HEAD_TIMEOUT_MS, ...opts.timers };
  let epochs = 0;
  const log = opts.log ?? ((m: string) => console.log(m));
  const wss = new WebSocketServer({ noServer: true, maxPayload: LINK_HELLO_MAX_PAYLOAD });
  const conns = new Set<Conn>();
  const byHost = new Map<string, Conn>();
  const states = new Map<string, LinkPresence>();
  const listeners = new Set<PresenceListener>();
  const asleepTimers = new Map<string, NodeJS.Timeout>();
  /** Domains the registry grants each host (union over its non-retired wolves), sorted; ONE registry read. Undefined when the read fails (never treated as "no grants"). */
  const grantedAll = (): Map<string, string[]> | undefined => {
    try {
      const by = new Map<string, Set<string>>();
      for (const w of opts.registry.list("wolves") as { host?: string; domains?: string[]; status?: string }[]) {
        if (!w.host || w.status === "retired") continue;
        if (!by.has(w.host)) by.set(w.host, new Set());
        for (const d of w.domains ?? []) by.get(w.host)!.add(d);
      }
      return new Map([...by].map(([h, set]) => [h, [...set].sort()] as const));
    } catch (e) {
      log(`hubd: link: registry read failed while computing KB grants (${(e as Error).message}); nothing sent`);
      return undefined;
    }
  };
  /** What each live host was last told, so a grants frame goes out only when the union really changed. Pruned on disconnect. */
  const sentGrants = new Map<string, string>();
  const machines = new Map<string, string>();
  const pushGrants = (hostIds: Iterable<string>) => {
    const all = grantedAll();
    if (!all) return; // skip: never send or cache [] on error
    for (const hostId of hostIds) {
      const c = byHost.get(hostId);
      if (!c || !c.hello || c.ws.readyState !== c.ws.OPEN) continue;
      const domains = all.get(hostId) ?? [];
      const key = JSON.stringify(domains);
      if (sentGrants.get(hostId) === key) continue;
      sentGrants.set(hostId, key);
      send(c, { t: "grants", domains });
    }
  };
  const offChange = opts.registry.onChange(() => pushGrants([...byHost.keys()]));
  const q = (v: unknown) => JSON.stringify(String(v).slice(0, 64)); // log-safe

  const setPresence = (hostId: string, p: LinkPresence) => {
    if ((states.get(hostId) ?? "offline") === p) return;
    states.set(hostId, p);
    clearTimeout(asleepTimers.get(hostId));
    asleepTimers.delete(hostId);
    if (p === "asleep") {
      const tm = setTimeout(() => {
        asleepTimers.delete(hostId);
        // A live link that has been active since the sleep frame is not asleep, whatever the timer says.
        const live = byHost.get(hostId);
        if (live && live.ws.readyState === live.ws.OPEN && live.activeAt > live.sleptAt) return setPresence(hostId, "online");
        setPresence(hostId, "offline");
      }, t.asleepOfflineMs);
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
    if (c.hello && !c.downNotified) {
      c.downNotified = true;
      try {
        opts.onDown?.(c.hostId, c.epoch);
      } catch (e) {
        log(`hubd: link ${c.hostId}: onDown failed: ${(e as Error).message}`);
      }
    }
    if (byHost.get(c.hostId) !== c) return; // replaced or never registered: presence belongs to the newer link
    byHost.delete(c.hostId);
    sentGrants.delete(c.hostId);
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
    const machine = normaliseMachine(h.machine);
    if (machine) machines.set(c.hostId, machine);
    else machines.delete(c.hostId); // an older worker reconnecting clears the stale value
    // Hello accepted: now allow full-size frames (ws keeps the limit on the receiver; there is no public setter).
    const receiver = (c.ws as unknown as { _receiver?: { _maxPayload?: number } })._receiver;
    if (receiver && typeof receiver._maxPayload === "number") receiver._maxPayload = LINK_MAX_PAYLOAD;
    else log(`hubd: WARNING link ${c.hostId}: ws internals changed (no _receiver._maxPayload); this connection stays limited to ${LINK_HELLO_MAX_PAYLOAD} bytes per frame`);
    if (result.rejected.length) log(`hubd: link ${c.hostId}: rejected wolves ${result.rejected.map(q).join(", ")}`);
    const all = grantedAll();
    const granted = all ? (all.get(c.hostId) ?? []) : undefined;
    send(c, { t: "welcome", v: LINK_PROTOCOL_VERSION, heartbeatMs: t.heartbeatMs, deadAfterMs: t.deadAfterMs, retired: result.retired, rejected: result.rejected, domainMismatch: result.domainMismatch, hubRevisions: {}, ...(granted ? { grantedDomains: granted } : {}) });
    if (granted) sentGrants.set(c.hostId, JSON.stringify(granted));
    else sentGrants.delete(c.hostId);
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
    if (f.t !== "ping" && f.t !== "pong" && f.t !== "sleep" && f.t !== "bye") {
      // Real activity: an asleep host that is sending work frames is not asleep.
      c.activeAt = Date.now();
      if (c.sleeping) {
        c.sleeping = false;
        setPresence(c.hostId, "online");
      }
    }
    switch (f.t) {
      case "hello":
        return sendError(c, "bad_frame", "duplicate hello");
      case "ping":
        return send(c, { t: "pong", n: f.n });
      case "sleep":
        c.sleeping = true;
        c.sleptAt = Date.now();
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
          pushGrants([c.hostId]); // a wolf attached: its granted domains join the union
        }
        return;
      case "wolf.remove":
        return opts.registry.removeWolf(c.hostId, f.name);
      case "contribute":
        if (opts.contributions) send(c, await opts.contributions.onContribute(c.hostId, f));
        return;
      case "receipt.ack":
        return opts.contributions?.onReceiptAck(c.hostId, f.id);
      case "res":
      case "chunk":
      case "end":
      case "rerr":
        return opts.onRelayFrame?.(c.hostId, c.epoch, f);
      default:
        return; // pong, req/cancel/pause/resume (hub-originated only): nothing to do
    }
  }

  function connect(ws: WebSocket, id: AuthIdentity & { tokenId: string; hostId: string }) {
    const c: Conn = { ws, tokenId: id.tokenId, hostId: id.hostId, sleeping: false, activeAt: 0, sleptAt: 0, bye: false, hubClosed: false, queue: Promise.resolve(), epoch: ++epochs };
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

  function sendToHost(hostId: string, frame: LinkFrame): boolean {
    const c = byHost.get(hostId);
    if (!c || c.ws.readyState !== c.ws.OPEN) return false;
    send(c, frame);
    return true;
  }

  function pushKbChanged(domain: string, rev: number, epoch: string): string[] {
    const hosts = new Set<string>();
    try {
      for (const w of opts.registry.list("wolves") as { host?: string; domains?: string[]; status?: string }[]) {
        if (w.host && w.status !== "retired" && (w.domains ?? []).includes(domain)) hosts.add(w.host);
      }
    } catch {
      return [];
    }
    const sent: string[] = [];
    for (const h of hosts) if (sendToHost(h, { t: "kb.changed", domain, rev, epoch })) sent.push(h);
    return sent;
  }

  return {
    handleUpgrade(req, socket, head) {
      socket.on("error", () => {});
      const id = opts.authenticate(req);
      if (!id) return reject(socket, "401 Unauthorized");
      if (id.kind !== "worker" || !id.hostId || !id.tokenId) return reject(socket, "403 Forbidden");
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
      offChange();
    },
    presence: (hostId) => states.get(hostId) ?? "offline",
    onPresence(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    sendToHost,
    epoch: (hostId) => byHost.get(hostId)?.epoch,
    machine: (hostId) => machines.get(hostId),
    relayHeadTimeoutMs: t.relayHeadTimeoutMs,
    pushKbChanged,
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
