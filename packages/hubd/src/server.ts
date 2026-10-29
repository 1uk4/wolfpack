/**
 * hubd: the pack authority. Serves the /v1 protocol's hub-scoped routes from a hub data directory. This ticket: work reads.
 * Later tickets slot into `dispatch` (work writes under the work-writer lock, claim, registry, /v1/events, ...).
 *
 * Auth: one shared X-API-Key; the acting identity comes from the protocol's actor (see `readActor` / `writeActor`; PROVISIONAL, asserted not proven).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  ACTOR_HEADER,
  ActorSchema,
  CreateWorkRequestSchema,
  PatchWorkRequestSchema,
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
  type WorkAppendedListener,
} from "./work-writes.js";
import { listWorkItems, readWorkRecordFor } from "./work-reads.js";

export const API_KEY_HEADER = "x-api-key";

export interface HubOptions {
  dataDir: string;
  /** Required shared secret (X-API-Key). */
  apiKey: string;
  /** 0 picks an ephemeral port. Default 0. */
  port?: number;
  /** Default 127.0.0.1. */
  host?: string;
  /** Max time to receive a request body, ms. Default 10000. */
  bodyTimeoutMs?: number;
  /**
   * @internal TEST-ONLY seam: awaited inside the write queue before each work write runs. The queue is single-file, so a gate
   * that never resolves blocks EVERY write (and close()). Never set it in production.
   */
  writeGate?: () => Promise<void> | void;
}

/** Fired after a write appended to the work ledger (inside the write queue, in ledger order). The events ticket subscribes here. */
export type { WorkAppendedListener };

export interface HubServer {
  /** Subscribe to ledger appends made by work writes; returns an unsubscribe. Listener errors are swallowed (logged). */
  onWorkAppended(listener: WorkAppendedListener): () => void;
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

const ACTOR_KEY = ACTOR_HEADER.toLowerCase();

/**
 * The asserted actor of a request (`X-Wolfpack-Actor`, PROVISIONAL: the shared key is the only authentication, so this is
 * asserted, not proven; see the protocol README). Absent = `undefined`. Malformed, or asserting `system` (reserved for hubd's
 * own internal jobs; a client cannot claim it) = 400 `invalid_request`.
 */
export function assertedActor(req: Pick<IncomingMessage, "headers">): Actor | undefined {
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
 * `ownerOnly` (owner-only operations) additionally requires kind `operator` (401 `unauthorized` otherwise).
 */
export function writeActor(req: Pick<IncomingMessage, "headers">, opts: { ownerOnly?: boolean } = {}): Actor {
  const actor = assertedActor(req);
  if (!actor) throw new HubError("invalid_request", `${ACTOR_HEADER} is required on this route`);
  if (opts.ownerOnly && actor.kind !== "operator") throw new HubError("unauthorized", "this operation is owner-only (actor kind operator)");
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
  if (!opts.apiKey) throw new Error("createHubServer: apiKey is required");
  const roots = hubRoots(opts.dataDir);
  mkdirSync(`${opts.dataDir}/ledger`, { recursive: true });
  // hubd is the ONLY writer of the work ledger. Take the cross-process lock before anything listens; a live second hubd on this
  // dataDir throws here (SandboxError, with a clear message).
  const writerLock = acquireWorkWriterLock(opts.dataDir);
  const writer = createWorkWriter({ roots, release: () => writerLock.release(), gate: opts.writeGate });
  const readBody = (req: IncomingMessage) => readJson(req, { maxBytes: WORK_BODY_LIMIT, timeoutMs: opts.bodyTimeoutMs ?? 10_000 });
  const writeWork = writer.write;
  let server!: Server;
  let port = 0;
  const host = opts.host ?? "127.0.0.1";
  try {
    // Hash both sides so the comparison is fixed-length (no length leak, timingSafeEqual never throws).
    const digest = (v: string) => createHash("sha256").update(v).digest();
    const expected = digest(opts.apiKey);
    const authed = (req: IncomingMessage): boolean => timingSafeEqual(digest(String(req.headers[API_KEY_HEADER] ?? "")), expected);

    async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const url = new URL(req.url ?? "/", "http://hubd");
      res.setHeader(PROTOCOL_VERSION_HEADER, String(PROTOCOL_VERSION));
      if (!authed(req)) throw new HubError("unauthorized", "missing or wrong X-API-Key");
      const m = matchRoute(req.method ?? "GET", url.pathname);
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
          const ops = normalisePatch(parseBody(PatchWorkRequestSchema, await readBody(req)));
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
          const item = await writeWork(actor, () => claimItem(roots, params.id, wolf));
          return send(res, 200, { item });
        }
        case "hubUnclaimWork": {
          const actor = writeActor(req);
          parseWolfId(actor);
          if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
          const item = await writeWork(actor, () => unclaimItem(roots, params.id, actor));
          return send(res, 200, { item });
        }
        case "hubGraduateWork": {
          const actor = writeActor(req);
          if (!WORK_ID.test(params.id)) throw new HubError("invalid_request", "malformed work item id");
          const item = await writeWork(actor, () => graduateItem(roots, params.id));
          return send(res, 200, { item });
        }
        default:
          // Wolf-scoped routes (threads, memory, KB, graduation, ...) belong to the wolf hosts, not the hub.
          throw new HubError("not_found", `${m.name} is served by a wolf host, not the hub`);
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
    writerLock.release();
    throw e;
  }
  return {
    dataDir: opts.dataDir,
    roots,
    port,
    url: `http://${host}:${port}`,
    onWorkAppended: (listener) => writer.onAppended(listener),
    /** Resolves once the writes already queued have drained and the lock is released. Can take up to 5s if a client holds a connection open (forced close after the grace period). */
    close: () =>
      new Promise<void>((resolve) => {
        // 1. stop admitting writes (new ones get a retryable `busy`), queue the lock release behind the writes already queued;
        const drained = writer.close();
        // 2. stop listening and drop idle connections; in-flight requests finish and get their responses;
        server.close(() => void drained.then(() => resolve()));
        server.closeIdleConnections?.();
        // 3. last resort for a stuck client: force-close after a grace period.
        setTimeout(() => server.closeAllConnections?.(), 5_000).unref();
      }),
  };
}
