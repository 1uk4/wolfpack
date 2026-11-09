/**
 * The hub-proxied Work API for VPS wolves: `<hub>/v1/workapi/work[...]`, the SAME request/response shapes as the agent's `/work` routes
 * (packages/agent routes/work.ts), so a wolf points WORK_ENDPOINT at `<hub>/v1/workapi` and its WorkClient / memory readers work unchanged.
 * Auth: the wolf's own hub token, sent as `X-API-Key` (what those clients send); dispatch maps it to a bearer for THIS prefix only.
 * hubd stays the single ledger writer: every write goes through the same write queue and kb work-ops as `/v1/work`.
 *
 * WHITELIST (everything else is 404/405): GET /work, GET /work/:id, POST /work, PATCH /work/:id, POST /work/:id/graduate.
 * No DELETE. `assign` ops: the owner on any item; a wolf only on its own loose item (a task of a feature follows the feature).
 *
 * SCOPE for a WORKER token (its host's wolves = the ACTIVE wolves the registry places on the token's host):
 *   reads   only items whose domain is subscribed by one of those wolves (list is filtered, a foreign item is 404 as if absent);
 *   create  only for the ACTING wolf (X-Wolf, else the host's only active wolf), or under a feature it holds (the item then takes that assignee), in a subscribed domain;
 *   patch / graduate  only items assigned to the acting wolf, in a subscribed domain.
 * Console/operator tokens are unrestricted (same whitelist). Errors are `{error: string}` like the agent's.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadWorkState, queryWork, resolveWorkItem, type CreateWorkInput, type WorkQuery } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { CreateWorkRequestSchema, PatchWorkBatchSchema, PatchWorkOpSchema, type Actor } from "@wolfpack/protocol";
import type { AuthIdentity } from "./auth.js";
import { HubError } from "./errors.js";
import { idempotencyKeyOf, type WorkIdempotency } from "./work-idempotency.js";
import { createItem, graduateItem, mapWorkError, normalisePatch, applyOps, WORK_STORE_PERMISSION_DENIED, PARENT_CLOSED, WORK_STORE_READ_ONLY } from "./work-writes.js";

export const WORK_PROXY_PREFIX = "/v1/workapi";
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
}

const respond = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
};
const STATUS: Record<string, number> = { invalid_request: 400, forbidden: 403, not_found: 404, unauthorized: 401, busy: 503 };
/** Typed write failures (HubError details.code, see ERRNO_TABLE in work-writes.ts): the status is decided by the typed code, not the protocol code. */
const TYPED_STATUS: Record<string, number> = { [WORK_STORE_READ_ONLY]: 503, [WORK_STORE_PERMISSION_DENIED]: 500, [PARENT_CLOSED]: 409 };

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
    // The acting wolf of a worker request: wolfActor names it (X-Wolf, or the host's only active wolf) or refuses.
    const actingWolf = (): string => d.wolfActor(tokenActor, named).id;
    const gate = (item: { assignee?: unknown }, w: string): void => {
      if (String(item.assignee) !== w) forbid(`assigned to ${String(item.assignee)}; only ${String(item.assignee)} or the owner can change it`);
    };
    const forbid = (m: string): never => {
      throw new HubError("forbidden", m);
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
      const item = loadWorkState(d.roots).get(id as never);
      if (!item || !domainOk(item.domain)) throw new HubError("not_found", `Work item not found: ${id}`); // a foreign domain looks absent
      return item;
    };

    if (rest.length === 0 && method === "GET") {
      const q: WorkQuery = {};
      for (const k of ["domain", "kind", "stage", "assignee", "area", "partOf"] as const) {
        const v = url.searchParams.get(k);
        if (v) (q as Record<string, string>)[k] = v;
      }
      const items = queryWork(d.roots, q).filter((i) => domainOk(i.domain));
      return respond(res, 200, { items });
    }
    if (rest.length === 0 && method === "POST") {
      const body = CreateWorkRequestSchema.safeParse(await d.readBody(req));
      if (!body.success) throw new HubError("invalid_request", "kind, domain, title, and assignee are required");
      if (worker) {
        if (!domainOk(body.data.domain)) forbid(`this worker host has no wolf subscribed to domain ${JSON.stringify(body.data.domain).slice(0, 60)}`);
        const parent = body.data.partOf ? loadWorkState(d.roots).get(body.data.partOf as never) : undefined;
        const w = actingWolf();
        if (body.data.assignee !== w) {
          if (parent && !parent.container && parent.assignee === w) body.data.assignee = w; // the new item takes its feature's assignee
          else forbid("a worker token can only create work assigned to the acting wolf, or under a feature it holds");
        }
      }
      const actor = d.wolfActor(tokenActor, named);
      return await once(actor, 201, () => createItem(d.roots, body.data as CreateWorkInput));
    }
    if (rest.length === 1 && method === "GET") {
      const item = itemOf(rest[0]!);
      const resolved = resolveWorkItem(d.roots, item.domain as string, item.id as string);
      return respond(res, 200, { item, body: resolved?.body ?? null });
    }
    if (rest.length === 1 && method === "PATCH") {
      const id = rest[0]!;
      const item = itemOf(id);
      if (worker) gate(item, actingWolf());
      const raw = await d.readBody(req);
      const isBatch = typeof raw === "object" && raw !== null && "ops" in raw;
      const parsed = (isBatch ? PatchWorkBatchSchema : PatchWorkOpSchema).safeParse(raw);
      if (!parsed.success) throw new HubError("invalid_request", parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; "));
      const ops = normalisePatch(parsed.data as never);
      if (worker && ops.some((o) => o.op === "assign")) {
        const parent = item.partOf ? loadWorkState(d.roots).get(item.partOf as never) : undefined;
        if (item.kind === "task" && parent && !parent.container) forbid(`this task follows its feature ${String(parent.id)}; only the owner can split it`);
      }
      const actor = d.wolfActor(tokenActor, named);
      return await once(actor, 200, () => ({ item: applyOps(d.roots, id, ops) }));
    }
    if (rest.length === 2 && rest[1] === "graduate" && method === "POST") {
      const id = rest[0]!;
      if (worker) gate(itemOf(id), actingWolf());
      const actor = d.wolfActor(tokenActor, named);
      return await once(actor, 200, () => ({ item: graduateItem(d.roots, id) }));
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
