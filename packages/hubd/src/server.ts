/**
 * hubd: the pack authority. Serves the /v1 protocol's hub-scoped routes from a hub data directory. This ticket: work reads.
 * Later tickets slot into `dispatch` (work writes under the work-writer lock, claim, registry, /v1/events, ...).
 *
 * Auth: every route except POST /v1/pair needs `Authorization: Bearer <device token>` (hashes in <dataDir>/auth/tokens.json). The acting
 * identity comes from the token; nothing else (no API key, no actor header) is accepted. A worker token acts as its host and may act
 * for any active wolf the registry places on that host (see wolfActorFor).
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeConsoleUrl, pairPageHtml } from "./pair-page.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CreateWorkRequestSchema,
  PairRequestSchema,
  PatchWorkBatchSchema,
  PatchWorkOpSchema,
  KbCommitRequestSchema,
  KbManifestDiffRequestSchema,
  ContributionCheckBodySchema,
  KbMatchBodySchema,
  KB_COMMIT_BODY_LIMIT,
  type KbCommitRequest,
  type KbCommitResponse,
  ERROR_HTTP_STATUS,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  matchRoute,
  type Actor,
  type ErrorCode,
  type ErrorEnvelope,
} from "@wolfpack/protocol";
import { isSafeSegment, type KbRoots } from "@wolfpack/kb/shared";
import { acquireWorkWriterLock } from "@wolfpack/engine";
import { HubError } from "./errors.js";
import { DEFAULT_SOCKET_MODE, listenOnSocket, removeSocket, type SocketIdentity } from "./socket.js";
import { contributionsRoot, hubRoots } from "./layout.js";
import { createEmbeddingCache, curatedTopics, matchKb, ollamaFromEnv, unchangedItems, type OllamaConfig } from "./crawl-endpoints.js";
import { ContributionError, readJsonObject, storeContribution } from "./contributions.js";
import {
  applyOps,
  claimItem,
  unclaimItem,
  createItem,
  createWorkWriter,
  deleteItem,
  graduateItem,
  isOwnerOnlyOp,
  normalisePatch,
  parseWolfId,
  stageRoot,
  sweepStageDirs,
  sweepProbeFiles,
  type WorkAppendedListener,
} from "./work-writes.js";
import { actorOf, createTokenStore, type AuthIdentity } from "./auth.js";
import { createEventBus } from "./events.js";
import { createKbWriter, type KbCommitFaults } from "./kb-commits.js";
import { createKbRevisions, type KbRetention } from "./kb-revisions.js";
import { loadWorkState } from "@wolfpack/kb/client";
import { createRegistry, releaseWolfClaims, type Collection, type RegistrySeed } from "./registry.js";
import { createLinkContributions, type LinkContributions } from "./link-contributions.js";
import { createLink, type Link, type LinkTimers } from "./link.js";
import { LINK_PATH, wolfForRoute } from "@wolfpack/protocol";
import { createRelay, type Relay } from "./relay.js";
import { listWorkItems, readWorkRecordFor } from "./work-reads.js";
import { handleWorkProxy, isWorkProxyPath } from "./work-proxy.js";

const singular = (c: Collection) => (c === "wolves" ? "wolf" : c.slice(0, -1));
type RegRoute = { c: Collection; op: "list" | "get" | "create" | "update" | "delete" | "retire" };
const REGISTRY_ROUTES: Record<string, RegRoute> = {};
for (const [c, S, P] of [["hosts", "Host", "Hosts"], ["wolves", "Wolf", "Wolves"], ["domains", "Domain", "Domains"], ["subscriptions", "Subscription", "Subscriptions"]] as const) {
  REGISTRY_ROUTES[`registryList${P}`] = { c, op: "list" };
  REGISTRY_ROUTES[`registryGet${S}`] = { c, op: "get" };
  REGISTRY_ROUTES[`registryCreate${S}`] = { c, op: "create" };
  REGISTRY_ROUTES[`registryUpdate${S}`] = { c, op: "update" };
  REGISTRY_ROUTES[`registryDelete${S}`] = { c, op: "delete" };
}
REGISTRY_ROUTES.registryRetireWolf = { c: "wolves", op: "retire" };
const registryRoute = (name: string): RegRoute | undefined => REGISTRY_ROUTES[name];

export interface HubOptions {
  dataDir: string;
  /** Where the pairing page sends the browser after a successful pair (the console's base URL; it receives the token in the URL fragment at /pair). Unset: the page just reports the token saved. */
  consoleUrl?: string;
  /** How often the running hub checks the token file for revokes (closing their SSE streams), ms. Default 1000. */
  authPollMs?: number;
  /** Clock (ms since epoch) for pairing-code expiry and last-used stamps. Tests inject one; default Date.now. */
  now?: () => number;
  /** How long a token-store mutation waits for the cross-process lock before `busy`, ms. Default 0 (fail fast; never stall the event loop). */
  authLockWaitMs?: number;
  /** Age after which a token-store lock is considered abandoned, ms. Default 10000. */
  authLockStaleMs?: number;
  /** 0 picks an ephemeral port. Default 0. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** Listen on this unix socket (absolute path) instead of TCP; mutually exclusive with port/host. For use behind a reverse proxy such as Caddy. */
  socketPath?: string;
  /** Socket file mode. Default 0660; any world bit is refused. */
  socketMode?: number;
  /** One-time registry seed (explicit paths only; used when the registry file does not exist yet). devices.yaml is never read. */
  registrySeed?: RegistrySeed;
  /** Max time to receive a request body, ms. Default 10000. */
  bodyTimeoutMs?: number;
  /**
   * @internal TEST-ONLY seam: awaited inside the write queue before each work write runs. The queue is single-file, so a gate
   * that never resolves blocks EVERY write (and close()). Never set it in production.
   */
  writeGate?: () => Promise<void> | void;
  /** Replay buffer size of GET /v1/events (events kept for Last-Event-ID resume). Default 1000. */
  eventBufferSize?: number;
  /** Max concurrent GET /v1/events streams; beyond it a new one is refused with 409 `busy` (retryable). Default 128. */
  maxEventStreams?: number;
  /** @internal TEST-ONLY: failure injection inside KB commits. */
  kbFaults?: KbCommitFaults;
  /** How often hubd scans the KB domain folders for direct writes (Dewey's), ms. Default 3000; 0 disables the timer (tests call scanKb). */
  kbPollMs?: number;
  /** A file modified more recently than this is left for the next scan, ms. Default 1500. */
  kbSettleMs?: number;
  /** @internal TEST-ONLY: KB change log retention (default 30 days or 10,000 changes, whichever keeps more). */
  kbRetention?: KbRetention;
  /** @internal TEST-ONLY: failure injection in link contribution handling. */
  linkFaults?: { beforeSeenAdd?: () => void };
  /** @internal TEST-ONLY: shrink the worker-link heartbeat / dead / hello timers. */
  linkTimers?: Partial<LinkTimers>;
  /** Librarian inbox root the hub delivers contributions into (`<root>/<wolf>/`). Default `<dataDir>/kb/ops/contributions`; on sfo-01 Dewey's `.../librarian/inbox`. Set by the `hubd` CLI from env HUBD_INBOX_ROOT (no flag). */
  inboxRoot?: string;
  /** Librarian receipts root the hub watches (`<root>/<wolf>/*.md`). Default `<dataDir>/kb/ops/receipts`. Set by the `hubd` CLI from env HUBD_RECEIPTS_ROOT (no flag). */
  receiptsRoot?: string;
  /** Embedding service for POST /v1/kb/match (default from env HUBD_OLLAMA_URL / HUBD_OLLAMA_MODEL; no URL = text matching only). */
  ollama?: OllamaConfig;
  /** Receipts lane poll, ms (default 3000; 0 = off). */
  receiptPollMs?: number;
  /** Resend an unacknowledged receipt after this long, ms (default 10000). */
  receiptAckTimeoutMs?: number;
  /** Per-item limit for contributions over the link, bytes (default 1 MiB). */
  linkContributionMaxBytes?: number;
  /** Bound on the persisted idempotency / delivered id sets (default 100000). */
  linkSeenMax?: number;
}

/** Fired after a write appended to the work ledger (inside the write queue, in ledger order). The events ticket subscribes here. */
export type { WorkAppendedListener };

export interface HubServer {
  /** Subscribe to ledger appends made by work writes; returns an unsubscribe. Listener errors are swallowed (logged). */
  onWorkAppended(listener: WorkAppendedListener): () => void;
  /** Publish a `kb.changed` event (entry ids, optional domain) to /v1/events subscribers; the KB commit path calls this. */
  emitKbChanged(entryIds: string[], domain?: string): void;
  /**
   * Commit a KB batch in-process (the curator child process, actor kind `system`, uses this; over HTTP only the operator may).
   * Same validation, atomicity and kb.changed emission as POST /v1/kb/commits. A `wolf` actor rejects `forbidden`.
   */
  commitKb(actor: Actor, req: KbCommitRequest): Promise<KbCommitResponse>;
  /**
   * The bearer check `dispatch` uses, exported for the HTTP `upgrade` path (which skips dispatch). `null` = not authenticated.
   */
  authenticate(req: IncomingMessage): AuthIdentity | null;
  /** Called (id of the revoked token) when the running hub detects a revoke (token file scan, within `authPollMs`). Returns an unsubscribe. */
  onRevoke(listener: (tokenId: string) => void): () => void;
  /** Scan the KB folders now (on the KB writer queue) and record direct writes as revisions; `prune` applies retention too. Resolves when done. */
  scanKb(opts?: { settle?: boolean; prune?: boolean }): Promise<void>;
  /** The worker link (GET /v1/link): presence, closeByToken/closeByHost, sendToWolf. */
  readonly link: Link;
  readonly dataDir: string;
  readonly roots: KbRoots;
  /** Base URL once listening. */
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export { HubError };

const WORK_ID = /^work-[a-z0-9-]+-[a-z0-9]{4,}$/i;
const retryable = (c: ErrorCode) => c === "busy" || c === "engine_error";

const PAIR_FAILS_PER_MIN = 10;
const PAIR_LIMITER_MAX_KEYS = 10_000;
/** Requests authenticated with a bearer token -> the actor the token maps to. */
const TOKEN_ACTOR = new WeakMap<object, Actor>();
/** The token behind a token-derived actor object (same object reaches the work writer), for attribution. */
const TOKEN_INFO = new WeakMap<Actor, { tokenId: string; hostId?: string }>();

/**
 * The actor of a request: the one its bearer token maps to (see actorOf), or `undefined` when the request carries no verified token.
 * Nothing the client sends (headers, body) can name or change it.
 */
export function assertedActor(req: Pick<IncomingMessage, "headers">): Actor | undefined {
  return TOKEN_ACTOR.get(req);
}

/** The actor of a READ: the token's one, else the `system` default. */
export function readActor(req: Pick<IncomingMessage, "headers">): Actor {
  return assertedActor(req) ?? SYSTEM_ACTOR;
}

/**
 * The actor of a MUTATING route (work writes, claim, ...): an authenticated token is REQUIRED (400 `invalid_request` when missing; dispatch already answers 401 first).
 * `ownerOnly` (owner-only operations) additionally requires kind `operator` (403 `forbidden` otherwise).
 */
export function writeActor(req: Pick<IncomingMessage, "headers">, opts: { ownerOnly?: boolean } = {}): Actor {
  const actor = assertedActor(req);
  if (!actor) throw new HubError("invalid_request", "an authenticated token is required on this route");
  if (opts.ownerOnly && actor.kind !== "operator") throw new HubError("forbidden", "this operation is owner-only (actor kind operator)");
  return actor;
}

/** hubd's own identity for its internal jobs and unattributed reads; never accepted from a client. */
export const SYSTEM_ACTOR: Actor = { id: "system", kind: "system" };

/** Per-route request body cap; later routes (KB commits) pass their own. */
export const WORK_BODY_LIMIT = 2 * 1024 * 1024;

/**
 * Read a JSON body. Called only AFTER auth/route/actor checks (dispatch authenticates before any route case reads a body).
 * Rejects early on Content-Length, checks the running size before buffering each chunk, and gives up after `timeoutMs`.
 * An oversized or timed-out request is drained/dropped so the error response can be delivered.
 */
function readJson(req: IncomingMessage, o: { maxBytes: number; timeoutMs: number }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    const fail = (e: HubError, drain: boolean) => {
      clearTimeout(timer);
      // Detach everything so nothing (e.g. `end`) parses the partial chunks afterwards.
      req.removeAllListeners("data");
      req.removeAllListeners("end");
      req.removeAllListeners("error");
      req.on("error", () => {}); // a late socket error must not become an unhandled 'error' event
      if (drain) req.resume();
      reject(e);
    };
    const timer = setTimeout(() => fail(new HubError("invalid_request", "timed out reading the request body"), false), o.timeoutMs);
    if (Number.isFinite(declared) && declared > o.maxBytes) return fail(new HubError("invalid_request", `request body too large (limit ${o.maxBytes} bytes)`), true);
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      if (n + c.length > o.maxBytes) return fail(new HubError("invalid_request", `request body too large (limit ${o.maxBytes} bytes)`), true);
      n += c.length;
      chunks.push(c);
    });
    req.once("error", () => fail(new HubError("invalid_request", "request aborted"), false));
    req.once("end", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HubError("invalid_request", "body is not valid JSON"));
      }
    });
  });
}
function parseBody<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  throw new HubError("invalid_request", r.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; "));
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

export async function createHubServer(opts: HubOptions): Promise<HubServer> {
  if (opts.socketPath !== undefined && (opts.port !== undefined || opts.host !== undefined)) throw new Error("socketPath cannot be combined with port/host");
  const consoleUrl = opts.consoleUrl ? normalizeConsoleUrl(opts.consoleUrl) : undefined; // throws on a bad URL before anything starts
  const roots = hubRoots(opts.dataDir);
  mkdirSync(`${opts.dataDir}/ledger`, { recursive: true });
  // hubd is the ONLY writer of the work ledger. Take the cross-process lock before anything listens; a live second hubd on this
  // dataDir throws here (SandboxError, with a clear message).
  const writerLock = acquireWorkWriterLock(opts.dataDir);
  // The write probe never climbs above <kb>/domains, so a fresh hub needs it to exist. Best effort (a read-only store already has it).
  try { mkdirSync(`${roots.kbBase}/domains`, { recursive: true }); } catch { /* read-only: nothing to create */ }
  { const n = sweepProbeFiles(roots); if (n > 0) console.error(`hubd: removed ${n} stale .probe-* file(s) from the work dirs`); } // stale .probe-* files of a crashed write probe
  sweepStageDirs(stageRoot(roots)); // scratch dirs orphaned by a crashed hubd (hub-owned <dataDir>/tmp, own prefix, dead pid)
  const revisions = createKbRevisions({
    dataDir: opts.dataDir,
    roots,
    now: opts.now,
    retention: opts.kbRetention,
    settleMs: opts.kbSettleMs,
    pollMs: opts.kbPollMs,
    exclusive: (fn) => kbWriter!.exclusive(fn),
    onRevision: (d, rev, epoch) => linkRef?.pushKbChanged(d, rev, epoch),
  });
  let linkRef: Link | undefined; // set once the link exists; revisions recorded before that have no one to notify
  let kbWriter: ReturnType<typeof createKbWriter> | undefined; // taken inside the start try below, so a failed start releases it
  const writer = createWorkWriter({
    roots,
    release: () => writerLock.release(),
    gate: opts.writeGate,
    // Attribution lives on the ledger events themselves (by / tokenId / hostId); the old auth/attribution.jsonl side log is retired.
    stamp: (actor) => {
      const info = TOKEN_INFO.get(actor);
      // Truncated to the schema's limits so a long actor id can never make the ledger append fail validation.
      return { by: actor.id.slice(0, 128), ...(info ? { tokenId: info.tokenId.slice(0, 128), ...(info.hostId ? { hostId: info.hostId.slice(0, 64) } : {}) } : {}) };
    },
  });
  const domainCache = new Map<string, string>(); // work item id -> domain
  const bus = createEventBus({
    bufferSize: opts.eventBufferSize,
    maxStreams: opts.maxEventStreams,
    domainOf: (ids) => {
      const out = new Map<string, string>();
      const miss = ids.filter((id) => !domainCache.has(id));
      if (miss.length > 0) {
        // Cache miss: one fold (inside the write queue) fills the cache for every item, so later batches hit.
        try {
          for (const [id, item] of loadWorkState(roots)) if (typeof item.domain === "string") domainCache.set(id as string, item.domain);
        } catch (e) {
          console.error("hubd: domain lookup for events failed:", e);
        }
      }
      for (const id of ids) {
        const d = domainCache.get(id);
        if (d) out.set(id, d);
      }
      return out;
    },
  });
  writer.onAppended(({ events }) => {
    // `work.created` is the only ledger event that carries a domain; seed the cache from it so the fold is rarely needed.
    for (const e of events) if (typeof e.domain === "string") domainCache.set(e.id, e.domain);
    try {
      bus.workAppended(events);
    } finally {
      for (const e of events) if (e.type === "work.deleted") domainCache.delete(e.id); // after emit: the event still reports its domain
    }
  });
  writer.onAppendFailed(() => bus.broadcastResync());
  const readBody = (req: IncomingMessage) => readJson(req, { maxBytes: WORK_BODY_LIMIT, timeoutMs: opts.bodyTimeoutMs ?? 10_000 });
  const writeWork = writer.write;
  let registry: ReturnType<typeof createRegistry>;
  try {
    registry = createRegistry({
      dataDir: opts.dataDir,
      seed: opts.registrySeed,
      heldBy: (wolf) => [...loadWorkState(roots).values()].filter((i) => i.boundBy === wolf).map((i) => i.id as string),
      releaseClaims: (wolf) => writeWork({ id: "system", kind: "system" }, () => releaseWolfClaims(roots, wolf)),
    });
  } catch (e) {
    writerLock.release();
    throw e;
  }
  let server!: Server;
  let port = 0;
  let socketId: SocketIdentity | undefined;
  let stopWatcher: () => void = () => {};
  let tokensFlush: () => void = () => {};
  let authenticateFn!: (req: IncomingMessage) => AuthIdentity | null;
  let link!: Link;
  let linkContrib!: LinkContributions;
  const inboxRoot = opts.inboxRoot ?? contributionsRoot(opts.dataDir);
  const receiptsRoot = opts.receiptsRoot ?? join(roots.opsRoot, "receipts");
  let relay!: Relay;
  let onRevokeFn!: (l: (tokenId: string) => void) => () => void;
  const host = opts.host ?? "127.0.0.1";
  try {
    kbWriter = createKbWriter({ dataDir: opts.dataDir, roots, onChanged: (ids, domain) => bus.emitKbChanged(ids, domain), faults: opts.kbFaults, onCommitted: (out) => revisions.record(out) });
    // Startup scan after KB recovery, before listening: records edits made while the hub was down (and the first-ever baseline).
    await kbWriter.exclusive(() => revisions.init());
    // Failed-redeem limiter, in memory, keyed by the socket peer address (behind a reverse proxy every client shares the proxy's
    // address; X-Forwarded-For is NOT trusted because anyone could forge it). Only failures are stored; empty entries are deleted,
    // a sweep runs every minute and the map is capped.
    const pairFailures = new Map<string, number[]>();
    const clock = () => (opts.now ?? Date.now)();
    const pairFailureCount = (addr: string, t: number): number => {
      const cur = (pairFailures.get(addr) ?? []).filter((x) => t - x < 60_000);
      if (cur.length === 0) pairFailures.delete(addr);
      else pairFailures.set(addr, cur);
      return cur.length;
    };
    const recordPairFailure = (addr: string, t: number): void => {
      // Read the CURRENT list now (not a snapshot from before the body was awaited): parallel requests must not lose counts.
      const cur = pairFailures.get(addr) ?? [];
      cur.push(t);
      pairFailures.set(addr, cur);
      if (pairFailures.size > PAIR_LIMITER_MAX_KEYS) pairFailures.delete(pairFailures.keys().next().value as string);
    };
    const sweeper = setInterval(() => {
      const t = clock();
      for (const addr of [...pairFailures.keys()]) pairFailureCount(addr, t);
    }, 60_000);
    sweeper.unref();
    const tokens = createTokenStore(opts.dataDir, opts.now, { waitMs: opts.authLockWaitMs ?? 0, staleMs: opts.authLockStaleMs });
    /** Open SSE responses per token id, so a revoke can close them. */
    const streams = new Map<string, Set<ServerResponse>>();
    const revokeListeners = new Set<(tokenId: string) => void>();
    const known = new Set<string>(tokens.ids()); // token ids seen live (file scans + authentications)
    const fireRevoked = (id: string) => {
      known.delete(id);
      for (const l of [...revokeListeners]) {
        try {
          l(id);
        } catch (e) {
          console.error("hubd: onRevoke listener failed:", e);
        }
      }
    };
    // The SSE close is the first onRevoke subscriber.
    revokeListeners.add((id) => {
      for (const r of [...(streams.get(id) ?? [])]) r.destroy();
      streams.delete(id);
    });
    const sweepRevoked = () => {
      const live = new Set(tokens.ids());
      for (const id of [...known]) if (!live.has(id)) fireRevoked(id);
      for (const id of live) known.add(id);
    };
    let stamp = tokens.stamp();
    const watcher = setInterval(() => {
      try {
        const now = tokens.stamp();
        if (now === stamp) return;
        stamp = now;
        sweepRevoked();
      } catch (e) {
        console.error("hubd: token watch failed:", e);
      }
    }, opts.authPollMs ?? 1000);
    watcher.unref();
    stopWatcher = () => {
      clearInterval(watcher);
      clearInterval(sweeper);
    };
    tokensFlush = () => tokens.flush();
    /** The shared check for dispatch AND the coming HTTP `upgrade` path. */
    function authenticate(req: IncomingMessage): AuthIdentity | null {
      const h = req.headers.authorization;
      if (typeof h === "string" && /^bearer /i.test(h)) {
        const rec = tokens.verify(h.slice(7).trim());
        if (!rec) return null;
        const actor = actorOf(rec);
        TOKEN_ACTOR.set(req, actor);
        TOKEN_INFO.set(actor, { tokenId: rec.id, ...(rec.hostId ? { hostId: rec.hostId } : {}) });
        known.add(rec.id);
        tokens.touch(rec.id);
        return { tokenId: rec.id, kind: rec.kind, ...(rec.hostId ? { hostId: rec.hostId } : {}), owner: rec.owner };
      }
      return null;
    }
    authenticateFn = authenticate;
    onRevokeFn = (l) => {
      revokeListeners.add(l);
      return () => void revokeListeners.delete(l);
    };
    const hostOf = (wolf: string): string | undefined => {
      try {
        const w = registry.get("wolves", wolf) as { host?: string; status?: string };
        return w.status === "retired" ? undefined : w.host || undefined;
      } catch {
        return undefined;
      }
    };
    linkContrib = createLinkContributions({
      dataDir: opts.dataDir,
      inboxRoot,
      receiptsRoot,
      hostOf,
      send: (h, f) => link.sendToHost(h, f),
      receiptPollMs: opts.receiptPollMs,
      receiptAckTimeoutMs: opts.receiptAckTimeoutMs,
      maxItemBytes: opts.linkContributionMaxBytes,
      seenMax: opts.linkSeenMax,
      faults: opts.linkFaults,
    });
    link = createLink({ authenticate, registry, timers: opts.linkTimers, onRelayFrame: (h, e, f) => relay.onFrame(h, e, f), onDown: (h, e) => relay.onDown(h, e), contributions: { onContribute: (h, f) => linkContrib.onContribute(h, f), onReceiptAck: (h, id) => linkContrib.onReceiptAck(h, id) } });
    linkRef = link;
    link.onPresence((h, p) => p === "online" && linkContrib.onHostOnline(h));
    relay = createRelay({ link, registry, bodyTimeoutMs: opts.bodyTimeoutMs });
    revokeListeners.add((id) => link.closeByToken(id));
    async function registryDispatch(req: IncomingMessage, res: ServerResponse, r: RegRoute, params: Record<string, string>): Promise<void> {
      if (r.op === "list") return send(res, 200, { [r.c]: registry.list(r.c) });
      if (r.op === "get") return send(res, 200, { [singular(r.c)]: registry.get(r.c, params.name!) });
      const actor = writeActor(req);
      if (actor.kind !== "operator") throw new HubError("forbidden", "registry writes need an operator actor");
      if (r.op === "create") {
        const out = await registry.create(r.c, await readBody(req));
        return send(res, 201, { [singular(r.c)]: out });
      }
      if (r.op === "update") {
        const body = (await readBody(req)) as Record<string, unknown>;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new HubError("invalid_request", "body must be an object");
        return send(res, 200, { [singular(r.c)]: await registry.update(r.c, params.name!, body) });
      }
      if (r.op === "retire") return send(res, 200, await registry.retire(params.name!));
      return send(res, 200, { deleted: await registry.remove(r.c, params.name!) });
    }

    /**
     * The wolf a request acts as. Operator/console tokens: the token's actor, unchanged. Worker token: the token's actor is its HOST, so it
     * may act for any ACTIVE wolf the registry places on that host (`named`, or the host's only active wolf when none is named; several = 400); a wolf on
     * another host, an unregistered or retired wolf is 403 `forbidden`.
     */
    function wolfActorFor(actor: Actor, named?: string): Actor {
      const info = TOKEN_INFO.get(actor);
      if (!info?.hostId) return actor;
      const wolves = registry.list("wolves") as { name: string; host?: string; status?: string }[];
      let wolf = named;
      if (wolf === undefined) {
        const mine = wolves.filter((w) => w.host === info.hostId && w.status === "active");
        if (mine.length > 1) throw new HubError("invalid_request", "this host has several active wolves: name the one this request acts for");
        if (mine.length === 0) throw new HubError("forbidden", "this worker host has no active wolf to act for");
        wolf = mine[0]!.name;
      }
      const w = wolves.find((x) => x.name === wolf);
      if (!w || w.status !== "active" || w.host !== info.hostId) throw new HubError("forbidden", `this worker host cannot act for wolf ${JSON.stringify(String(wolf)).slice(0, 60)}`);
      const out: Actor = { id: wolf, kind: "wolf" };
      TOKEN_INFO.set(out, info);
      return out;
    }
    /** The optional `{wolf}` a worker token's claim/unclaim names. Read whenever a body is present (Content-Length > 0 or Transfer-Encoding set; same cap as other JSON bodies); invalid JSON is 400. */
    async function namedWolf(req: IncomingMessage, actor: Actor): Promise<string | undefined> {
      if (!TOKEN_INFO.get(actor)?.hostId) return undefined;
      const hasBody = Number(req.headers["content-length"]) > 0 || req.headers["transfer-encoding"] !== undefined;
      if (!hasBody) return undefined;
      const b = await readBody(req);
      if (b === undefined || b === null) return undefined;
      if (typeof b !== "object" || Array.isArray(b)) throw new HubError("invalid_request", "body must be a JSON object");
      const w = (b as { wolf?: unknown }).wolf;
      if (w !== undefined && typeof w !== "string") throw new HubError("invalid_request", "wolf must be a string");
      return w;
    }

    /** The wolf a receipts/check request is about: query `wolf`, else (worker token) the host's only active wolf; an operator must name it. */
    function receiptWolf(req: IncomingMessage, url: URL): string {
      const named = url.searchParams.get("wolf") ?? undefined;
      const actor = writeActor(req);
      if (TOKEN_INFO.get(actor)?.hostId) return wolfActorFor(actor, named).id; // worker: only an active wolf of its host
      if (actor.kind === "wolf") {
        if (named !== undefined && named !== actor.id) throw new HubError("forbidden", "a wolf may only read its own contributions");
        return actor.id;
      }
      if (named === undefined) throw new HubError("invalid_request", "name the wolf (query wolf=<name>)");
      if (!isSafeSegment(named) || !/^[a-z0-9][a-z0-9._-]*$/.test(named)) throw new HubError("invalid_request", "bad wolf name");
      return named;
    }

    /** The KB domains `id` may read: undefined = all (console/operator/browser identities); a worker token: the domains its host's active wolves subscribe to. */
    function readableDomains(id: AuthIdentity): Set<string> | undefined {
      if (id.kind !== "worker") return undefined;
      const out = new Set<string>();
      for (const w of registry.list("wolves") as { host?: string; domains?: string[]; status?: string }[]) {
        if (id.hostId !== undefined && w.host === id.hostId && w.status !== "retired") for (const d of w.domains ?? []) out.add(d);
      }
      return out;
    }
    const kbMatchCache = createEmbeddingCache();

    /** KB sync reads: a worker token sees only the domains its host's wolves subscribe to; console/browser tokens see all. */
    function requireKbDomain(id: AuthIdentity | undefined, domain: string): void {
      if (!id || id.kind !== "worker") return;
      const hostId = id.hostId;
      const allowed = hostId !== undefined && (registry.list("wolves") as { host?: string; domains?: string[]; status?: string }[]).some((w) => w.host === hostId && w.status !== "retired" && (w.domains ?? []).includes(domain));
      if (!allowed) throw new HubError("forbidden", `this worker is not subscribed to KB domain ${domain.slice(0, 60)}`);
    }

    async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? "/", "http://hubd");
      res.setHeader(PROTOCOL_VERSION_HEADER, String(PROTOCOL_VERSION));
      // Hub-proxied Work API for VPS wolves (work-proxy.ts): the wolf's own hub token arrives as X-API-Key (what the Work clients send).
      // Mapped to a bearer for THIS prefix only; everything else still needs Authorization: Bearer.
      if (isWorkProxyPath(url.pathname)) {
        const key = req.headers["x-api-key"];
        if (typeof key === "string" && key.trim() && typeof req.headers.authorization !== "string") req.headers.authorization = `Bearer ${key.trim()}`;
        const id = authenticate(req);
        if (!id) throw new HubError("unauthorized", "missing or invalid token");
        return handleWorkProxy(
          { roots, wolves: () => registry.list("wolves") as never, readBody, writeWork, wolfActor: (a, n) => wolfActorFor(a, n) },
          req, res, url, id, writeActor(req),
        );
      }
      const m = matchRoute(req.method ?? "GET", url.pathname);
      const isPublic = typeof m === "object" && m.route.public === true;
      let tokenId: string | undefined;
      let identity: AuthIdentity | undefined;
      if (!isPublic) {
        const id = authenticate(req); // 401 before 404/405/body reads
        if (!id) throw new HubError("unauthorized", "missing or invalid bearer token");
        tokenId = id.tokenId;
        identity = id;
      }
      if (m === undefined) throw new HubError("not_found", `no route ${url.pathname}`);
      if (m === "method") throw new HubError("invalid_request", `method ${req.method} not allowed`);
      const v = req.headers[PROTOCOL_VERSION_HEADER.toLowerCase()];
      if (typeof v === "string") {
        if (!/^\d+$/.test(v.trim())) throw new HubError("invalid_request", `bad ${PROTOCOL_VERSION_HEADER}`);
        if (Number(v) !== PROTOCOL_VERSION) throw new HubError("version_mismatch", `server speaks protocol ${PROTOCOL_VERSION}, client sent ${v}`);
      }
      readActor(req); // validated for every request; write routes call writeActor() and record the token identity on the ledger event
      const { params } = m;
      switch (m.name) {
        case "hubPairPage": {
          const html = pairPageHtml(consoleUrl);
          res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Length": Buffer.byteLength(html),
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            "X-Frame-Options": "DENY",
          });
          return void res.end(html);
        }
        case "hubPair": {
          const addr = req.socket.remoteAddress ?? "?"; // the socket peer; X-Forwarded-For is deliberately NOT trusted
          const t = (opts.now ?? Date.now)();
          // NOTE: the failure bucket is keyed on the socket peer. Behind a local reverse proxy (tailscale serve) every request is 127.0.0.1, so the bucket is GLOBAL (see RUNBOOK 5b).
          if (pairFailureCount(addr, t) >= PAIR_FAILS_PER_MIN) {
            res.setHeader("Retry-After", "60");
            return send(res, 429, { code: "busy", message: "too many failed pairing attempts; retry in a minute", retryable: true } satisfies ErrorEnvelope);
          }
          const body = parseBody(PairRequestSchema, await readBody(req));
          try {
            const out = tokens.redeem(body.code, body.label, body.kind, body.hostId);
            console.log(`hubd: paired token ${out.tokenId} kind=${out.kind} label=${JSON.stringify(out.label)}${out.hostId ? ` hostId=${out.hostId}` : ""}`);
            return send(res, 200, { token: out.token, tokenId: out.tokenId, ...(out.hostId ? { hostId: out.hostId } : {}) });
          } catch (e) {
            if (e instanceof HubError && e.code === "unauthorized") recordPairFailure(addr, t);
            throw e;
          }
        }
        case "listWolves":
          // The pack's wolf list from the registry: online when the owning host's link is online (asleep/offline hosts show offline; the relay names the state).
          // A worker token sees only its own host's wolves (it must not enumerate other hosts).
          return send(res, 200, { wolves: (registry.list("wolves") as { name: string; host?: string; status?: string }[]).filter((w) => w.status !== "retired" && (!identity || identity.kind !== "worker" || w.host === identity.hostId)).map((w) => ({ id: w.name, name: w.name, host: w.host ?? "", status: w.host && link.presence(w.host) === "online" ? "online" : "offline" })) });
        case "hubListWork": {
          const domain = url.searchParams.get("domain");
          if (!domain) throw new HubError("invalid_request", "domain is required");
          const flag = url.searchParams.get("graduated");
          if (flag !== null && flag !== "true" && flag !== "false") throw new HubError("invalid_request", "graduated must be true or false");
          return send(res, 200, listWorkItems(roots, domain, flag === "true"));
        }
        case "hubGetWorkRecord": {
          if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
          const rec = readWorkRecordFor(roots, params.id);
          if (!rec) throw new HubError("not_found", `work item ${params.id}`);
          return send(res, 200, rec);
        }
        case "submitContribution": {
          const tokenActor = writeActor(req);
          try {
            const submitted = await readJsonObject(req, res);
            const named = typeof submitted.json.from === "string" ? submitted.json.from : undefined;
            const stored = storeContribution(opts.dataDir, wolfActorFor(tokenActor, named), submitted, inboxRoot);
            return send(res, stored.duplicate ? 200 : 201, stored);
          } catch (e) {
            if (e instanceof ContributionError) throw new HubError(e.code, e.message, e.details);
            throw e;
          }
        }
        case "hubContributionReceipts": {
          const wolf = receiptWolf(req, url);
          return send(res, 200, { curated: curatedTopics(opts.dataDir, wolf, inboxRoot) });
        }
        case "hubContributionCheck": {
          const wolf = receiptWolf(req, url);
          const body = parseBody(ContributionCheckBodySchema, await readJson(req, { maxBytes: WORK_BODY_LIMIT, timeoutMs: opts.bodyTimeoutMs ?? 10_000 }));
          return send(res, 200, { unchanged: unchangedItems(opts.dataDir, wolf, body.items, inboxRoot) });
        }
        case "hubKbMatch": {
          const body = parseBody(KbMatchBodySchema, await readJson(req, { maxBytes: KB_COMMIT_BODY_LIMIT, timeoutMs: opts.bodyTimeoutMs ?? 10_000 }));
          if (!identity) throw new HubError("unauthorized", "missing or invalid bearer token"); // dispatch already guarantees this; never fall through to "every domain"
          for (const c of body.candidates) if (c.domain) requireKbDomain(identity, c.domain);
          return send(res, 200, await matchKb(roots, body.candidates, opts.ollama ?? ollamaFromEnv(), readableDomains(identity), kbMatchCache));
        }
        case "hubCreateWork": {
          const actor = writeActor(req);
          const body = parseBody(CreateWorkRequestSchema, await readBody(req));
          const out = await writeWork(actor, () => createItem(roots, body));
          return send(res, 201, out);
        }
        case "hubPatchWork": {
          let actor = writeActor(req);
          if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
          // Pick the arm by shape so a malformed body reports the real issue, not a bare "invalid_union".
          const raw = await readBody(req);
          const isBatch = typeof raw === "object" && raw !== null && "ops" in raw;
          const ops = normalisePatch(isBatch ? parseBody(PatchWorkBatchSchema, raw) : parseBody(PatchWorkOpSchema, raw));
          if (ops.some(isOwnerOnlyOp)) actor = writeActor(req, { ownerOnly: true });
          const item = await writeWork(actor, () => applyOps(roots, params.id, ops));
          return send(res, 200, { item });
        }
        case "hubDeleteWork": {
          const actor = writeActor(req);
          if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
          const deleted = await writeWork(actor, () => deleteItem(roots, params.id));
          return send(res, 200, { deleted });
        }
        case "hubClaimWork": {
          const tokenActor = writeActor(req);
          const actor = wolfActorFor(tokenActor, await namedWolf(req, tokenActor));
          const wolf = parseWolfId(actor);
          if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
          // Checked inside the queue, so it is ordered against a retire. A wolf with no registry entry is not refused (registry optional until cutover).
          const item = await writeWork(actor, () => {
            if (registry.isRetired(wolf)) throw new HubError("forbidden", `wolf ${wolf} is retired and cannot claim work`);
            return claimItem(roots, params.id, wolf);
          });
          return send(res, 200, { item });
        }
        case "hubUnclaimWork": {
          const tokenActor = writeActor(req);
          const actor = wolfActorFor(tokenActor, await namedWolf(req, tokenActor));
          parseWolfId(actor);
          if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
          const item = await writeWork(actor, () => unclaimItem(roots, params.id, actor));
          return send(res, 200, { item });
        }
        case "hubKbCommit": {
          const actor = writeActor(req); // `system` cannot be asserted, so over HTTP this is the operator; a wolf is 403 below
          if (actor.kind !== "operator") throw new HubError("forbidden", "only the operator (or the in-process curator) may commit to the KB");
          const body = parseBody(KbCommitRequestSchema, await readJson(req, { maxBytes: KB_COMMIT_BODY_LIMIT, timeoutMs: opts.bodyTimeoutMs ?? 10_000 }));
          return send(res, 200, await kbWriter!.commit(actor, body));
        }
        case "hubKbChanges": {
          requireKbDomain(identity, params.domain);
          const q = url.searchParams;
          const sinceRaw = q.get("since");
          if (sinceRaw !== null && !/^\d{1,15}$/.test(sinceRaw)) throw new HubError("invalid_request", "since must be a non-negative integer");
          if (sinceRaw !== null && Number(sinceRaw) > 0 && q.get("epoch") === null) throw new HubError("invalid_request", "epoch is required when since > 0");
          const mb = q.get("maxBytes");
          if (mb !== null && !/^[1-9]\d{0,12}$/.test(mb)) throw new HubError("invalid_request", "maxBytes must be a positive integer");
          return send(res, 200, revisions.changesSince(params.domain, sinceRaw === null ? 0 : Number(sinceRaw), q.get("epoch") ?? undefined, mb === null ? undefined : Math.min(Number(mb), KB_COMMIT_BODY_LIMIT)));
        }
        case "hubKbManifest": {
          requireKbDomain(identity, params.domain);
          return send(res, 200, revisions.manifest(params.domain));
        }
        case "hubKbManifestDiff": {
          requireKbDomain(identity, params.domain);
          const body = parseBody(KbManifestDiffRequestSchema, await readJson(req, { maxBytes: KB_COMMIT_BODY_LIMIT, timeoutMs: opts.bodyTimeoutMs ?? 10_000 }));
          return send(res, 200, revisions.diff(params.domain, body.files, body.maxBytes === undefined ? undefined : Math.min(body.maxBytes, KB_COMMIT_BODY_LIMIT)));
        }
        case "hubEvents": {
          const hdr = req.headers["last-event-id"];
          const cursor = (Array.isArray(hdr) ? hdr[0] : hdr)?.trim() || url.searchParams.get("from")?.trim() || undefined;
          bus.attach(res, cursor);
          if (tokenId) {
            // Revoked between auth and attach, or later (the watcher): close this stream.
            if (!tokens.ids().includes(tokenId)) return void res.destroy();
            let set = streams.get(tokenId);
            if (!set) streams.set(tokenId, (set = new Set()));
            set.add(res);
            res.once("close", () => set!.delete(res));
          }
          return;
        }
        case "hubGraduateWork": {
          const actor = writeActor(req);
          if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
          const item = await writeWork(actor, () => graduateItem(roots, params.id));
          return send(res, 200, { item });
        }
        default: {
          const reg = registryRoute(m.name);
          if (reg) return registryDispatch(req, res, reg, params);
          // Wolf-scoped routes (threads, memory, KB, graduation, ...) belong to the wolf hosts: tunnelled over the host's link (relay.ts).
          // A worker token must not reach into any host's wolves; console/browser tokens may.
          const wolf = wolfForRoute(params);
          if (!wolf) throw new HubError("not_found", `no wolf in ${url.pathname}`);
          if (identity && identity.kind === "worker") throw new HubError("forbidden", "a worker token cannot use the console relay");
          return relay.handle(req, res, wolf, url.pathname + url.search); // the routed URL, never raw req.url
        }
      }
    }

    server = createServer((req, res) => {
      dispatch(req, res).catch((e: unknown) => {
        if (!(e instanceof HubError)) console.error(`hubd: ${req.method} ${req.url} failed:`, e); // detail stays server-side
        const err = e instanceof HubError ? e : new HubError("engine_error", "internal hub error");
        const env: ErrorEnvelope = { code: err.code, message: err.message, retryable: retryable(err.code), ...(err.details ? { details: err.details } : {}) };
        if (!res.headersSent) send(res, ERROR_HTTP_STATUS[err.code], env);
        else res.end();
      });
    });
    server.on("upgrade", (req, socket, head) => {
      if ((req.url ?? "").split("?")[0] === LINK_PATH) link.handleUpgrade(req, socket, head);
      else {
        socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
      }
    });
    await new Promise<void>((resolve, reject) => {
      if (opts.socketPath !== undefined) listenOnSocket(server, opts.socketPath, opts.socketMode ?? DEFAULT_SOCKET_MODE).then((id) => ((socketId = id), resolve()), reject);
      else {
        server.once("error", reject);
        server.listen(opts.port ?? 0, host, () => resolve());
      }
    });
    if (opts.socketPath === undefined) port = (server.address() as AddressInfo).port;
    revisions.start();
  } catch (e) {
    // Anything between acquire and listening failed. Nothing is queued on this path, so release the lock SYNCHRONOUSLY: a caller
    // that retries the moment this rejects must not still see it held.
    server?.close();
    if (opts.socketPath !== undefined) removeSocket(opts.socketPath, socketId);
    stopWatcher();
    revisions.stop();
    kbWriter?.abort(); // synchronous: a caller that retries the moment this rejects must not see the KB lock held
    writerLock.release();
    throw e;
  }
  return {
    dataDir: opts.dataDir,
    roots,
    port,
    url: opts.socketPath !== undefined ? `unix:${opts.socketPath}` : `http://${host}:${port}`,
    get link() {
      return link;
    },
    authenticate: (req) => authenticateFn(req),
    onRevoke: (l) => onRevokeFn(l),
    emitKbChanged: (ids, domain) => bus.emitKbChanged(ids, domain),
    commitKb: (actor, req) => kbWriter!.commit(actor, req),
    scanKb: async (o) => void (await kbWriter!.exclusive(() => revisions.scan(o))),
    onWorkAppended: (listener) => writer.onAppended(listener),
    /** Resolves once the writes already queued have drained and the lock is released. Can take up to 5s if a client holds a connection open (forced close after the grace period). */
    close: () =>
      new Promise<void>((resolve) => {
        // 1. stop admitting writes (new ones get a retryable `busy`), queue the lock release behind the writes already queued;
        revisions.stop(); // before the KB writer closes
        const drained = Promise.all([writer.close(), kbWriter!.close()]).then(() => undefined);
        stopWatcher();
        tokensFlush();
        bus.closeAll();
        linkContrib?.stop();
        link.closeAll();
        // 2. stop listening and drop idle connections; in-flight requests finish and get their responses;
        server.close(() => {
          if (opts.socketPath !== undefined) removeSocket(opts.socketPath, socketId);
          void drained.then(() => resolve());
        });
        server.closeIdleConnections?.();
        // bus.closeAll() ended the SSE streams, but a response that has just been ended only counts as idle once its final bytes
        // flush, so the sweep above misses it; sweep again shortly after so shutdown doesn't wait for the 5s forced close.
        setTimeout(() => server.closeIdleConnections?.(), 50).unref();
        // 3. last resort for a stuck client: force-close after a grace period.
        setTimeout(() => server.closeAllConnections?.(), 5_000).unref();
      }),
  };
}
