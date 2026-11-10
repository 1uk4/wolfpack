/**
 * The hub-proxied Work API for VPS wolves: `<hub>/v1/workapi/work[...]`, the SAME request/response shapes as the agent's `/work` routes
 * (packages/agent routes/work.ts), so a wolf points WORK_ENDPOINT at `<hub>/v1/workapi` and its WorkClient / memory readers work unchanged.
 * Auth: the wolf's own hub token, sent as `X-API-Key` (what those clients send); dispatch maps it to a bearer for THIS prefix only.
 * hubd stays the single ledger writer: every write goes through the same write queue and kb work-ops as `/v1/work`.
 *
 * WHITELIST (everything else is 404/405): GET /work, GET /work/:id, POST /work, PATCH /work/:id, POST /work/:id/graduate.
 * No DELETE.
 *
 * GATE for a WORKER token acting as wolf W (X-Wolf, else the host's only active wolf; its host's wolves = the ACTIVE wolves the registry places on it):
 *   reads   only items whose domain is subscribed by one of those wolves (list is filtered, a foreign item is 404 as if absent);
 *   notes   a request made only of `note` ops and/or `section` ops named exactly "Record" (the `## Record` heading) is open to any item;
 *           a batch mixing in other ops goes through the full gate (the Record is memory's fold, written by whichever wolf holds the work);
 *   write / move / assign / graduate  only items assigned to W (no domain check on writes: the gate checks only the assignee;
 *           an unassigned item can only be changed by the owner);
 *   move    under a feature held by another wolf X is a handoff: the task is also assigned to X in the same write (`reassigned` in the answer);
 *   create  assigned to W (no parent, or the Inbox), or under any feature (the item takes that feature's assignee); in a subscribed domain.
 * Decisions: write checks use the assignee only, so a worker can get 403 (or note) on items in domains it cannot read; this is accepted.
 * Create keeps the domain check on purpose, so a worker cannot create into a domain its host does not subscribe to.
 * Only TASKS hand off on a move; a feature moved under another feature keeps its assignee.
 * The item read, the gate and the handoff lookup of PATCH/graduate run inside the write queue, so they cannot race another write.
 * `assign` (any caller) must name an active wolf of the registry. Assigning a feature also reassigns its open child tasks (not shipped,
 * live or archived): all for the owner, only those held by W for a worker; the others are left alone.
 * A worker cannot write the Record of an ARCHIVED item, held or not: 409 `item is archived; its Record is closed` (code record_closed).
 * Notes on an archived item are not refused (unchanged).
 * The create path reads the parent feature OUTSIDE the write queue, so a feature reassigned mid-request is not seen (low risk).
 * Console/operator tokens can do anything (same whitelist). Errors are `{error: string}` like the agent's.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { filterWork, loadWorkState, resolveWorkItem, type CreateWorkInput, type WorkId, type WorkQuery } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { CreateWorkRequestSchema, PatchWorkBatchSchema, PatchWorkOpSchema, type Actor } from "@wolfpack/protocol";
import type { AuthIdentity } from "./auth.js";
import { HubError } from "./errors.js";
import { cachedWorkState } from "./work-state.js";
import { idempotencyKeyOf, type WorkIdempotency } from "./work-idempotency.js";
import { createItem, graduateItem, mapWorkError, normalisePatch, applyOps, type WorkOp, WORK_STORE_PERMISSION_DENIED, PARENT_CLOSED, WORK_STORE_READ_ONLY, RECORD_CLOSED, LOG_FULL } from "./work-writes.js";

export const WORK_PROXY_PREFIX = "/v1/workapi";
/** The refusal for a worker's loose create for another wolf: names who can do it. */
export const LOOSE_CREATE_FOREIGN_WOLF = "a wolf can only create a loose item for itself; only the owner can assign one to another wolf";
/** Most ids one `GET /work?ids=` may name. */
const MAX_IDS = 200;
const WORK_ID = /^work-[a-z0-9-]+-[a-z0-9]{4,}$/i;

interface WolfRow {
  name: string;
  host?: string;
  status?: string;
  domains?: string[];
}
export interface WorkProxyDeps {
  roots: KbRoots;
  wolves: () => WolfRow[];
  readBody: (req: IncomingMessage) => Promise<unknown>;
  /** The write queue of /v1/work. */
  writeWork: <T>(actor: Actor, fn: () => T) => Promise<T>;
  /** The actor a worker token acts as for the named wolf (403 for a wolf of another host). Non-worker tokens: unchanged. */
  wolfActor: (tokenActor: Actor, named?: string) => Actor;
  /** First answers by `Idempotency-Key`: a resent write (a wolf's outbox replay) gets that answer and is not applied again. */
  idempotency?: WorkIdempotency;
  /** A recordAppend was applied to this item (it appends no ledger event, so the console is told here: work.changed). */
  recordAppended?: (id: string) => void;
}

const respond = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
};
const STATUS: Record<string, number> = { invalid_request: 400, forbidden: 403, not_found: 404, unauthorized: 401, busy: 503 };
/** Typed write failures (HubError details.code, see ERRNO_TABLE in work-writes.ts): the status is decided by the typed code, not the protocol code. */
const TYPED_STATUS: Record<string, number> = { [WORK_STORE_READ_ONLY]: 503, [WORK_STORE_PERMISSION_DENIED]: 500, [PARENT_CLOSED]: 409, [RECORD_CLOSED]: 409, [LOG_FULL]: 409 };

/** Is this request under the proxy prefix? */
export const isWorkProxyPath = (pathname: string): boolean => pathname === `${WORK_PROXY_PREFIX}/work` || pathname.startsWith(`${WORK_PROXY_PREFIX}/work/`);

export async function handleWorkProxy(d: WorkProxyDeps, req: IncomingMessage, res: ServerResponse, url: URL, identity: AuthIdentity, tokenActor: Actor): Promise<void> {
  try {
    const rest = url.pathname.slice(`${WORK_PROXY_PREFIX}/work`.length).split("/").filter(Boolean); // [] | [id] | [id, "graduate"]
    const method = req.method ?? "GET";
    const worker = identity.kind === "worker";
    const named = typeof req.headers["x-wolf"] === "string" ? (req.headers["x-wolf"] as string) : undefined;
    const mine = worker ? d.wolves().filter((w) => w.host === identity.hostId && w.status === "active") : [];
    const myNames = new Set(mine.map((w) => w.name));
    const myDomains = new Set(mine.flatMap((w) => w.domains ?? []));
    const domainOk = (domain: unknown): boolean => !worker || myDomains.has(String(domain));
    // The acting actor, resolved once per request: wolfActor names the wolf (X-Wolf, or the host's only active wolf) or refuses.
    let actorMemo: Actor | undefined;
    const actorOf = (): Actor => (actorMemo ??= d.wolfActor(tokenActor, named));
    const forbid = (m: string): never => {
      throw new HubError("forbidden", m);
    };
    const NO_ASSIGNEE = "this item has no assignee; only the owner can change it";
    const gate = (item: { assignee?: unknown }, w: string): void => {
      if (!item.assignee) forbid(NO_ASSIGNEE);
      if (String(item.assignee) !== w) forbid(`assigned to ${String(item.assignee)}; only ${String(item.assignee)} or the owner can change it`);
    };
    // An assign target (and a handoff target) must be an active wolf the hub knows; applies to the owner too.
    const knownWolf = (name: string): void => {
      if (!d.wolves().some((w) => w.name === name && w.status === "active")) throw new HubError("invalid_request", `unknown assignee ${JSON.stringify(name).slice(0, 80)}: not an active wolf known to this hub`);
    };
    /** Write lookups: the gate checks only the assignee (the domain check of round 1 is dropped on purpose), so no domain filter. */
    const writeItemOf = (id: string) => {
      if (!WORK_ID.test(id)) throw new HubError("invalid_request", "malformed work item id");
      const item = loadWorkState(d.roots).get(id as never);
      if (!item) throw new HubError("not_found", `Work item not found: ${id}`);
      return item;
    };
    // A write with a key runs at most once: checked and recorded inside the write queue, so two resends cannot both apply.
    // Only writes use a key: a read with a malformed one is answered, not refused.
    const rawKey = ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? idempotencyKeyOf(req.headers["idempotency-key"]) : undefined;
    const key = rawKey && d.idempotency ? `${identity.tokenId}:${rawKey}` : undefined;
    const once = async (actor: Actor, status: number, fn: () => unknown): Promise<void> => {
      const out = await d.writeWork(actor, () => {
        const seen = key ? d.idempotency!.get(key) : undefined;
        if (seen) return seen;
        const answer = { status, body: fn() };
        if (key) d.idempotency!.add(key, answer);
        return answer;
      });
      respond(res, out.status, out.body);
    };
    const itemOf = (id: string) => {
      if (!WORK_ID.test(id)) throw new HubError("invalid_request", "malformed work item id");
      const item = cachedWorkState(d.roots).get(id as never);
      if (!item || !domainOk(item.domain)) throw new HubError("not_found", `Work item not found: ${id}`); // a foreign domain looks absent
      return item;
    };

    // A reader that already hung up gets nothing: skip the state load and the serialization (a retry storm must not queue work nobody reads).
    const gone = (): boolean => req.socket?.destroyed === true || res.destroyed || res.writableEnded;
    if (method === "GET" && gone()) return;
    if (rest.length === 0 && method === "GET") {
      const q: WorkQuery = {};
      for (const k of ["domain", "kind", "stage", "assignee", "area", "partOf"] as const) {
        const v = url.searchParams.get(k);
        if (v) (q as Record<string, string>)[k] = v;
      }
      // `ids`: comma-separated full work ids; only those items, IN REQUEST ORDER (deduped, unknown skipped), other filters still apply (filterWork keeps input order). Empty `ids=` = absent; over MAX_IDS = 400.
      const wanted = [...new Set((url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean))];
      if (wanted.length > MAX_IDS) throw new HubError("invalid_request", `ids: at most ${MAX_IDS} ids per request`);
      const state = cachedWorkState(d.roots);
      const pool = wanted.length ? wanted.flatMap((id) => { const it = state.get(id as WorkId); return it ? [it] : []; }) : [...state.values()];
      let items: readonly Record<string, unknown>[] = filterWork(pool, q).filter((i) => domainOk(i.domain));
      // `archived=0` drops archived items; `fields=summary` drops the heavy `log` and `successCriteria`. Without them the list is unchanged.
      if (url.searchParams.get("archived") === "0") items = items.filter((i) => i.stage !== "archived");
      if (url.searchParams.get("fields") === "summary") items = items.map(({ log: _log, successCriteria: _sc, ...slim }) => slim);
      return respond(res, 200, { items });
    }
    if (rest.length === 0 && method === "POST") {
      const body = CreateWorkRequestSchema.safeParse(await d.readBody(req));
      if (!body.success) throw new HubError("invalid_request", "kind, domain, title, and assignee are required");
      if (worker) {
        if (!domainOk(body.data.domain)) forbid(`this worker host has no wolf subscribed to domain ${JSON.stringify(body.data.domain).slice(0, 60)}`);
        const parent = body.data.partOf ? loadWorkState(d.roots).get(body.data.partOf as never) : undefined;
        const w = actorOf().id;
        if (parent && parent.kind === "feature" && !parent.container) {
          // Under any feature the new item takes that feature's assignee (the same rule as a move-handoff).
          if (!parent.assignee) forbid(NO_ASSIGNEE);
          knownWolf(String(parent.assignee)); // a retired or unknown wolf cannot be given new work
          body.data.assignee = String(parent.assignee);
        } else if (body.data.assignee !== w) forbid(LOOSE_CREATE_FOREIGN_WOLF);
      }
      const actor = actorOf();
      const inherited = worker && body.data.assignee !== actor.id ? { assignedTo: body.data.assignee } : {}; // says who got it when that is not the acting wolf
      return await once(actor, 201, () => ({ ...createItem(d.roots, body.data as CreateWorkInput), ...inherited }));
    }
    if (rest.length === 1 && method === "GET") {
      const item = itemOf(rest[0]!);
      const resolved = resolveWorkItem(d.roots, item.domain as string, item.id as string);
      return respond(res, 200, { item, body: resolved?.body ?? null });
    }
    if (rest.length === 1 && method === "PATCH") {
      const id = rest[0]!;
      writeItemOf(id); // fast 400/404 before the body is read; the authoritative read happens in the queue below
      const raw = await d.readBody(req);
      const isBatch = typeof raw === "object" && raw !== null && "ops" in raw;
      const parsed = (isBatch ? PatchWorkBatchSchema : PatchWorkOpSchema).safeParse(raw);
      if (!parsed.success) throw new HubError("invalid_request", parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; "));
      const ops = normalisePatch(parsed.data as never);
      const actor = actorOf();
      // The item, the gate and the handoff lookup run INSIDE the write queue: a reassignment that lands between check and write is seen.
      return await once(actor, 200, () => {
        const state = loadWorkState(d.roots);
        const item = state.get(id as never);
        if (!item) throw new HubError("not_found", `Work item not found: ${id}`);
        // normaliseOne maps ONLY the literal "Record" to the internal name "record", so this exemption cannot be reached with another spelling.
        const isRecordWrite = (o: WorkOp): boolean => (o.op === "section" && o.name === "record") || o.op === "recordAppend";
        // A request of only notes and Record-section writes is open to any item; anything else (plan, other sections, body, a mix) goes through the full gate.
        if (worker && !ops.every((o) => o.op === "note" || isRecordWrite(o))) gate(item, actor.id);
        // The Record of an archived item is closed to workers, held or not (the owner is unaffected).
        if (worker && item.stage === "archived" && ops.some(isRecordWrite)) throw new HubError("invalid_request", "item is archived; its Record is closed", { code: RECORD_CLOSED });
        const finalOps: WorkOp[] = [];
        const reassigned: { id: string; from: string | null; to: string }[] = [];
        let current = item.assignee ? String(item.assignee) : null;
        for (const o of ops) {
          finalOps.push(o);
          if (o.op === "assign") {
            knownWolf(o.to);
            current = o.to;
          } else if (o.op === "moveTo" && item.kind === "task" && o.partOf) {
            // A move under a feature held by another wolf is a handoff: the task goes to that wolf in the same write.
            const target = state.get(o.partOf.trim() as never);
            if (target && target.kind === "feature" && !target.container && target.assignee && String(target.assignee) !== current) {
              const to = String(target.assignee);
              knownWolf(to);
              finalOps.push({ op: "assign", to });
              reassigned.push({ id, from: current, to });
              current = to;
            }
          }
        }
        // A worker's feature cascade is limited to the children it holds; the owner's reaches every open child.
        const holder = worker ? actor.id : undefined;
        const recordAdded = { count: 0 };
        const applied = applyOps(d.roots, id, finalOps, {}, { holder, recordAdded });
        // A replay that deduped to nothing changed no file: no work.changed.
        if (recordAdded.count > 0) d.recordAppended?.(id);
        return { item: applied, ...(reassigned.length ? { reassigned } : {}) };
      });
    }
    if (rest.length === 2 && rest[1] === "graduate" && method === "POST") {
      const id = rest[0]!;
      writeItemOf(id);
      const actor = actorOf();
      return await once(actor, 200, () => {
        if (worker) gate(writeItemOf(id), actor.id); // re-read inside the queue
        return { item: graduateItem(d.roots, id) };
      });
    }
    // Known path shape with a method outside the whitelist (DELETE, ...) or an unknown path.
    throw new HubError(rest.length <= 2 ? "invalid_request" : "not_found", rest.length <= 2 ? `method ${method} is not available through the work proxy` : `no route ${url.pathname}`);
  } catch (e) {
    const err = e instanceof HubError ? e : mapWorkError(e, { write: req.method !== "GET" });
    const typed = err.details?.code;
    if (!res.headersSent) respond(res, (typed ? TYPED_STATUS[typed] : undefined) ?? STATUS[err.code] ?? 500, { error: err.message, ...(typed && TYPED_STATUS[typed] ? { code: typed } : {}) });
    else res.end();
  }
}
