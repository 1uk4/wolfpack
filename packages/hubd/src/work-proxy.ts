/**
 * The hub-proxied Work API for VPS wolves: `<hub>/v1/workapi/work[...]`, the SAME request/response shapes as the agent's `/work` routes
 * (packages/agent routes/work.ts), so a wolf points WORK_ENDPOINT at `<hub>/v1/workapi` and its WorkClient / memory readers work unchanged.
 * Auth: the wolf's own hub token, sent as `X-API-Key` (what those clients send); dispatch maps it to a bearer for THIS prefix only.
 * hubd stays the single ledger writer: every write goes through the same write queue and kb work-ops as `/v1/work`.
 *
 * WHITELIST (everything else is 404/405): GET /work, GET /work/:id, POST /work, PATCH /work/:id, POST /work/:id/graduate.
 * No DELETE, no assignee changes (those are `assign` ops, operator-only on /v1/work).
 *
 * SCOPE for a WORKER token (its host's wolves = the ACTIVE wolves the registry places on the token's host):
 *   reads   only items whose domain is subscribed by one of those wolves (list is filtered, a foreign item is 404 as if absent);
 *   create  only for an assignee that is one of those wolves, in a subscribed domain;
 *   patch / graduate  only items assigned to (or bound by) one of those wolves, in a subscribed domain.
 * Console/operator tokens are unrestricted (same whitelist). Errors are `{error: string}` like the agent's.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadWorkState, queryWork, resolveWorkItem, type CreateWorkInput, type WorkQuery } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { CreateWorkRequestSchema, PatchWorkBatchSchema, PatchWorkOpSchema, type Actor } from "@wolfpack/protocol";
import type { AuthIdentity } from "./auth.js";
import { HubError } from "./errors.js";
import { createItem, graduateItem, mapWorkError, normalisePatch, applyOps } from "./work-writes.js";

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
}

const respond = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
};
const STATUS: Record<string, number> = { invalid_request: 400, forbidden: 403, not_found: 404, unauthorized: 401, busy: 503, memory_unavailable: 503 };

/** Is this request under the proxy prefix? */
export const isWorkProxyPath = (pathname: string): boolean => pathname === `${WORK_PROXY_PREFIX}/work` || pathname.startsWith(`${WORK_PROXY_PREFIX}/work/`);

export async function handleWorkProxy(d: WorkProxyDeps, req: IncomingMessage, res: ServerResponse, url: URL, identity: AuthIdentity, tokenActor: Actor): Promise<void> {
  try {
    const rest = url.pathname.slice(`${WORK_PROXY_PREFIX}/work`.length).split("/").filter(Boolean); // [] | [id] | [id, "graduate"]
    const method = req.method ?? "GET";
    const worker = identity.kind === "worker";
    const mine = worker ? d.wolves().filter((w) => w.host === identity.hostId && w.status === "active") : [];
    const myNames = new Set(mine.map((w) => w.name));
    const myDomains = new Set(mine.flatMap((w) => w.domains ?? []));
    const domainOk = (domain: unknown): boolean => !worker || myDomains.has(String(domain));
    const ownerOk = (item: { assignee?: unknown; boundBy?: unknown; domain?: unknown }): boolean => !worker || (domainOk(item.domain) && (myNames.has(String(item.assignee)) || myNames.has(String(item.boundBy))));
    const forbid = (m: string): never => {
      throw new HubError("forbidden", m);
    };
    const named = typeof req.headers["x-wolf"] === "string" ? (req.headers["x-wolf"] as string) : undefined;
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
        if (!myNames.has(body.data.assignee)) forbid("a worker token can only create work assigned to a wolf of its own host");
      }
      const actor = d.wolfActor(tokenActor, named);
      const out = await d.writeWork(actor, () => createItem(d.roots, body.data as CreateWorkInput));
      return respond(res, 201, out);
    }
    if (rest.length === 1 && method === "GET") {
      const item = itemOf(rest[0]!);
      const resolved = resolveWorkItem(d.roots, item.domain as string, item.id as string);
      return respond(res, 200, { item, body: resolved?.body ?? null });
    }
    if (rest.length === 1 && method === "PATCH") {
      const id = rest[0]!;
      ownerOk0(itemOf(id), ownerOk, forbid);
      const raw = await d.readBody(req);
      const isBatch = typeof raw === "object" && raw !== null && "ops" in raw;
      const parsed = (isBatch ? PatchWorkBatchSchema : PatchWorkOpSchema).safeParse(raw);
      if (!parsed.success) throw new HubError("invalid_request", parsed.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; "));
      const ops = normalisePatch(parsed.data as never);
      if (ops.some((o) => o.op === "assign")) forbid("assigning work is not available through the work proxy");
      const actor = d.wolfActor(tokenActor, named);
      const item = await d.writeWork(actor, () => applyOps(d.roots, id, ops));
      return respond(res, 200, { item });
    }
    if (rest.length === 2 && rest[1] === "graduate" && method === "POST") {
      const id = rest[0]!;
      ownerOk0(itemOf(id), ownerOk, forbid);
      const actor = d.wolfActor(tokenActor, named);
      const item = await d.writeWork(actor, () => graduateItem(d.roots, id));
      return respond(res, 200, { item });
    }
    // Known path shape with a method outside the whitelist (DELETE, ...) or an unknown path.
    throw new HubError(rest.length <= 2 ? "invalid_request" : "not_found", rest.length <= 2 ? `method ${method} is not available through the work proxy` : `no route ${url.pathname}`);
  } catch (e) {
    const err = e instanceof HubError ? e : mapWorkError(e);
    if (!res.headersSent) respond(res, STATUS[err.code] ?? 500, { error: err.message });
    else res.end();
  }
}

function ownerOk0(item: { assignee?: unknown; boundBy?: unknown; domain?: unknown }, ownerOk: (i: typeof item) => boolean, forbid: (m: string) => never): void {
  if (!ownerOk(item)) forbid("a worker token can only change work assigned to a wolf of its own host");
}
