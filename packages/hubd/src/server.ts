/**
 * hubd: the pack authority. Serves the /v1 protocol's hub-scoped routes from a hub data directory. This ticket: work reads.
 * Later tickets slot into `dispatch` (work writes under the work-writer lock, claim, registry, /v1/events, ...).
 *
 * Auth: every route except POST /v1/pair needs `Authorization: Bearer <device token>` (hashes in <dataDir>/auth/tokens.json). The acting
 * identity comes from the token; X-Wolfpack-Actor is IGNORED for token requests. LEGACY (temporary): when `apiKey` is set, a request with
 * a matching X-API-Key and no bearer is accepted and its identity is the asserted X-Wolfpack-Actor (PROVISIONAL, asserted not proven).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { normalizeConsoleUrl, pairPageHtml } from "./pair-page.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACTOR_HEADER,
  ActorSchema,
  CreateWorkRequestSchema,
  PairRequestSchema,
  PatchWorkBatchSchema,
  PatchWorkOpSchema,
  KbCommitRequestSchema,
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
import type { KbRoots } from "@wolfpack/kb/shared";
import { acquireWorkWriterLock } from "@wolfpack/engine";
import { HubError } from "./errors.js";
import { hubRoots } from "./layout.js";
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
  type WorkAppendedListener,
} from "./work-writes.js";
import { actorOf, createTokenStore, OWNER, type AuthIdentity } from "./auth.js";
import { createEventBus } from "./events.js";
import { createKbWriter, type KbCommitFaults } from "./kb-commits.js";
import { loadWorkState } from "@wolfpack/kb/client";
import { createRegistry, releaseWolfClaims, type Collection, type RegistrySeed } from "./registry.js";
import { listWorkItems, readWorkRecordFor } from "./work-reads.js";

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

export const API_KEY_HEADER = "x-api-key";

export interface HubOptions {
  dataDir: string;
  /** LEGACY, optional: shared secret (X-API-Key) accepted alongside device tokens until the legacy path is removed. */
  apiKey?: string;
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
   * The bearer check `dispatch` uses, exported for the HTTP `upgrade` path (which skips dispatch). `null` = not authenticated. A legacy
   * HUBD_API_KEY request resolves to `{owner, legacy: true}` with NO tokenId, kind or hostId, so callers can refuse it.
   */
  authenticate(req: IncomingMessage): AuthIdentity | null;
  /** Called (id of the revoked token) when the running hub detects a revoke (token file scan, within `authPollMs`). Returns an unsubscribe. */
  onRevoke(listener: (tokenId: string) => void): () => void;
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
const ACTOR_KEY = ACTOR_HEADER.toLowerCase();
/** Requests authenticated with a bearer token -> the actor the token maps to. */
const TOKEN_ACTOR = new WeakMap<object, Actor>();
/** The token behind a token-derived actor object (same object reaches the work writer), for attribution. */
const TOKEN_INFO = new WeakMap<Actor, { tokenId: string; hostId?: string }>();

/**
 * The asserted actor of a request (`X-Wolfpack-Actor`, PROVISIONAL: the shared key is the only authentication, so this is
 * asserted, not proven; see the protocol README). Absent = `undefined`. Malformed, or asserting `system` (reserved for hubd's
 * own internal jobs; a client cannot claim it) = 400 `invalid_request`.
 */
export function assertedActor(req: Pick<IncomingMessage, "headers">): Actor | undefined {
  const fromToken = TOKEN_ACTOR.get(req);
  if (fromToken) return fromToken; // token identity: the header is not even parsed
  const raw = req.headers[ACTOR_KEY];
  if (typeof raw !== "string") return undefined;
  let parsed: ReturnType<typeof ActorSchema.safeParse> | undefined;
  try {
    parsed = ActorSchema.safeParse(JSON.parse(raw));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) throw new HubError("invalid_request", `bad ${ACTOR_HEADER}`);
  if (parsed.data.kind === "system") throw new HubError("invalid_request", `${ACTOR_HEADER}: the system actor is reserved for the hub`);
  return parsed.data;
}

/** The actor of a READ: the asserted one, else the `system` default. */
export function readActor(req: Pick<IncomingMessage, "headers">): Actor {
  return assertedActor(req) ?? SYSTEM_ACTOR;
}

/**
 * The actor of a MUTATING route (work writes, claim, ...): an explicit actor is REQUIRED (400 `invalid_request` when missing).
 * `ownerOnly` (owner-only operations) additionally requires kind `operator` (403 `forbidden` otherwise).
 */
export function writeActor(req: Pick<IncomingMessage, "headers">, opts: { ownerOnly?: boolean } = {}): Actor {
  const actor = assertedActor(req);
  if (!actor) throw new HubError("invalid_request", `${ACTOR_HEADER} is required on this route`);
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
  const consoleUrl = opts.consoleUrl ? normalizeConsoleUrl(opts.consoleUrl) : undefined; // throws on a bad URL before anything starts
  const roots = hubRoots(opts.dataDir);
  mkdirSync(`${opts.dataDir}/ledger`, { recursive: true });
  // hubd is the ONLY writer of the work ledger. Take the cross-process lock before anything listens; a live second hubd on this
  // dataDir throws here (SandboxError, with a clear message).
  const writerLock = acquireWorkWriterLock(opts.dataDir);
  sweepStageDirs(stageRoot(roots)); // scratch dirs orphaned by a crashed hubd (hub-owned <dataDir>/tmp, own prefix, dead pid)
  let kbWriter: ReturnType<typeof createKbWriter> | undefined; // taken inside the start try below, so a failed start releases it
  const writer = createWorkWriter({ roots, release: () => writerLock.release(), gate: opts.writeGate });
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
  // Attribution of token-authenticated writes: the ledger event schema has no actor field, so tokenId + hostId go to a side log
  // (<dataDir>/auth/attribution.jsonl, one line per write) naming the events that write appended.
  writer.onAppended(({ actor, events }) => {
    const info = TOKEN_INFO.get(actor);
    if (!info) return;
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...info, actor, events: events.map((e) => ({ id: e.id, type: e.type })) });
      mkdirSync(`${opts.dataDir}/auth`, { recursive: true });
      appendFileSync(`${opts.dataDir}/auth/attribution.jsonl`, line + "\n", { mode: 0o600 });
    } catch (e) {
      console.error("hubd: could not record write attribution:", e);
    }
  });
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
  let stopWatcher: () => void = () => {};
  let tokensFlush: () => void = () => {};
  let authenticateFn!: (req: IncomingMessage) => AuthIdentity | null;
  let onRevokeFn!: (l: (tokenId: string) => void) => () => void;
  const host = opts.host ?? "127.0.0.1";
  try {
    kbWriter = createKbWriter({ dataDir: opts.dataDir, roots, onChanged: (ids, domain) => bus.emitKbChanged(ids, domain), faults: opts.kbFaults });
    // Hash both sides so the comparison is fixed-length (no length leak, timingSafeEqual never throws).
    const digest = (v: string) => createHash("sha256").update(v).digest();
    const expected = opts.apiKey ? digest(opts.apiKey) : undefined;
    const legacyOk = (req: IncomingMessage): boolean => expected !== undefined && timingSafeEqual(digest(String(req.headers[API_KEY_HEADER] ?? "")), expected);
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
        if (!rec) return null; // a bad bearer never falls back to the legacy key
        const actor = actorOf(rec);
        TOKEN_ACTOR.set(req, actor);
        TOKEN_INFO.set(actor, { tokenId: rec.id, ...(rec.hostId ? { hostId: rec.hostId } : {}) });
        known.add(rec.id);
        tokens.touch(rec.id);
        return { tokenId: rec.id, kind: rec.kind, ...(rec.hostId ? { hostId: rec.hostId } : {}), owner: rec.owner };
      }
      if (legacyOk(req)) return { owner: OWNER, legacy: true }; // no tokenId, kind or hostId
      return null;
    }
    authenticateFn = authenticate;
    onRevokeFn = (l) => {
      revokeListeners.add(l);
      return () => void revokeListeners.delete(l);
    };
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

    async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? "/", "http://hubd");
      res.setHeader(PROTOCOL_VERSION_HEADER, String(PROTOCOL_VERSION));
      const m = matchRoute(req.method ?? "GET", url.pathname);
      const isPublic = typeof m === "object" && m.route.public === true;
      let tokenId: string | undefined;
      if (!isPublic) {
        const id = authenticate(req); // 401 before 404/405/body reads
        if (!id) throw new HubError("unauthorized", "missing or invalid bearer token");
        tokenId = id.tokenId;
      }
      if (m === undefined) throw new HubError("not_found", `no route ${url.pathname}`);
      if (m === "method") throw new HubError("invalid_request", `method ${req.method} not allowed`);
      const v = req.headers[PROTOCOL_VERSION_HEADER.toLowerCase()];
      if (typeof v === "string") {
        if (!/^\d+$/.test(v.trim())) throw new HubError("invalid_request", `bad ${PROTOCOL_VERSION_HEADER}`);
        if (Number(v) !== PROTOCOL_VERSION) throw new HubError("version_mismatch", `server speaks protocol ${PROTOCOL_VERSION}, client sent ${v}`);
      }
      readActor(req); // validated for every request; write routes (later tickets) call writeActor() and record it on the ledger event
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
          if (pairFailureCount(addr, t) >= PAIR_FAILS_PER_MIN) {
            res.setHeader("Retry-After", "60");
            return send(res, 429, { code: "busy", message: "too many failed pairing attempts; retry in a minute", retryable: true } satisfies ErrorEnvelope);
          }
          const body = parseBody(PairRequestSchema, await readBody(req));
          try {
            const out = tokens.redeem(body.code, body.label, body.kind, body.hostId);
            console.log(`hubd: paired token ${out.tokenId} kind=${out.kind} label=${JSON.stringify(body.label)}${out.hostId ? ` hostId=${out.hostId}` : ""}`);
            return send(res, 200, { token: out.token, tokenId: out.tokenId });
          } catch (e) {
            if (e instanceof HubError && e.code === "unauthorized") recordPairFailure(addr, t);
            throw e;
          }
        }
        case "listWolves":
          // The hub is not a wolf host. (The registry ticket makes this the pack's wolf list.)
          return send(res, 200, { wolves: [] });
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
          const actor = writeActor(req);
          try {
            const stored = storeContribution(opts.dataDir, actor, await readJsonObject(req, res));
            return send(res, stored.duplicate ? 200 : 201, stored);
          } catch (e) {
            if (e instanceof ContributionError) throw new HubError(e.code, e.message);
            throw e;
          }
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
          const actor = writeActor(req);
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
          const actor = writeActor(req);
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
          // Wolf-scoped routes (threads, memory, KB, graduation, ...) belong to the wolf hosts, not the hub.
          throw new HubError("not_found", `${m.name} is served by a wolf host, not the hub`);
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
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port ?? 0, host, () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  } catch (e) {
    // Anything between acquire and listening failed. Nothing is queued on this path, so release the lock SYNCHRONOUSLY: a caller
    // that retries the moment this rejects must not still see it held.
    server?.close();
    stopWatcher();
    kbWriter?.abort(); // synchronous: a caller that retries the moment this rejects must not see the KB lock held
    writerLock.release();
    throw e;
  }
  return {
    dataDir: opts.dataDir,
    roots,
    port,
    url: `http://${host}:${port}`,
    authenticate: (req) => authenticateFn(req),
    onRevoke: (l) => onRevokeFn(l),
    emitKbChanged: (ids, domain) => bus.emitKbChanged(ids, domain),
    commitKb: (actor, req) => kbWriter!.commit(actor, req),
    onWorkAppended: (listener) => writer.onAppended(listener),
    /** Resolves once the writes already queued have drained and the lock is released. Can take up to 5s if a client holds a connection open (forced close after the grace period). */
    close: () =>
      new Promise<void>((resolve) => {
        // 1. stop admitting writes (new ones get a retryable `busy`), queue the lock release behind the writes already queued;
        const drained = Promise.all([writer.close(), kbWriter!.close()]).then(() => undefined);
        stopWatcher();
        tokensFlush();
        bus.closeAll();
        // 2. stop listening and drop idle connections; in-flight requests finish and get their responses;
        server.close(() => void drained.then(() => resolve()));
        server.closeIdleConnections?.();
        // bus.closeAll() ended the SSE streams, but a response that has just been ended only counts as idle once its final bytes
        // flush, so the sweep above misses it; sweep again shortly after so shutdown doesn't wait for the 5s forced close.
        setTimeout(() => server.closeIdleConnections?.(), 50).unref();
        // 3. last resort for a stuck client: force-close after a grace period.
        setTimeout(() => server.closeAllConnections?.(), 5_000).unref();
      }),
  };
}
