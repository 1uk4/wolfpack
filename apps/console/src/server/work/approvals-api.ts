/**
 * OWNER APPROVALS (work-wolfpack-WITFT19): the console's door to the hub's approval requests for graduate, archive and reassign.
 * Behind the console's owner gate, every call goes to the hub with the caller's OWN device token (the gate has verified it); the
 * console never uses its own hub token here. hubd decides who may approve: a worker token gets 403, which is passed through.
 *   GET  /api/work/requests               pending requests (hub GET /v1/work/requests?status=pending)
 *   POST /api/work/requests/<rid>/approve | /reject
 * `pendingApprovals` is the same read for the needs-you list (no gate: it only lists), with each request's work item title.
 */
import type { ApprovalRequest } from "@wolfpack/protocol";
import { bearerOf } from "../../core/ui/hub-auth.ts";
import { healthApi } from "../pack/health-api.ts";

const NO_STORE = { "Cache-Control": "no-store" };

export interface ApprovalsApiDeps {
	gate: (req: Request) => Promise<string | Response>;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

const fail = (status: number, error: string, code: string, extra: object = {}): Response => Response.json({ error, code, ...extra }, { status, headers: NO_STORE });

/** The hub's refusal as a typed console error: 403 stays 403, 409 / 400 / 404 keep their hub code, anything else is a 502. */
async function hubFailure(r: Response): Promise<Response> {
	const body = (await r.json().catch(() => ({}))) as { code?: string; message?: string; details?: object };
	const message = body.message ?? `The hub answered ${r.status}.`;
	if (r.status === 403) return fail(403, message, body.code ?? "forbidden");
	if (r.status === 409) return fail(409, message, body.code ?? "conflict", body.details ? { details: body.details } : {});
	if (r.status === 400) return fail(400, message, body.code ?? "invalid_request");
	if (r.status === 404) return fail(404, message, body.code ?? "not_found");
	if (r.status === 401) return fail(401, message, "unauthorized");
	return fail(502, message, "failed");
}

export function createApprovalsApi(d: ApprovalsApiDeps) {
	const env = d.env ?? process.env;
	const doFetch = d.fetch ?? fetch;
	const call = async (req: Request, method: string, path: string): Promise<Response> => {
		const g = await d.gate(req);
		if (g instanceof Response) return g;
		const base = env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
		const token = bearerOf(req.headers.get("authorization"));
		if (!base || !token) return fail(501, "This console has no hub (WOLFPACK_HUB_URL is not set).", "unsupported");
		try {
			const r = await doFetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(d.timeoutMs ?? 5000) });
			if (!r.ok) return await hubFailure(r);
			return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json", ...NO_STORE } });
		} catch {
			return fail(503, "The hub is not answering.", "hub_unreachable");
		}
	};
	const rid = (id: string) => encodeURIComponent(id);
	return {
		list: (req: Request) => call(req, "GET", "/v1/work/requests?status=pending"),
		get: (req: Request, id: string) => call(req, "GET", `/v1/work/requests/${rid(id)}`),
		approve: (req: Request, id: string) => call(req, "POST", `/v1/work/requests/${rid(id)}/approve`),
		reject: (req: Request, id: string) => call(req, "POST", `/v1/work/requests/${rid(id)}/reject`),
	};
}

/** A pending request with the title of the work item it is about (the id when the hub cannot say). */
export type PendingApproval = ApprovalRequest & { title: string };

/** The pending requests for the needs-you list, read with the caller's token. An unreachable hub or a refusing token is an empty list. */
export async function pendingApprovals(token: string | null | undefined, env: Record<string, string | undefined> = process.env, doFetch: typeof fetch = fetch): Promise<PendingApproval[]> {
	const base = env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
	if (!base || !token) return [];
	const get = (path: string) => doFetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
	try {
		const r = await get("/v1/work/requests?status=pending");
		if (!r.ok) return [];
		const requests = ((await r.json()) as { requests?: ApprovalRequest[] }).requests ?? [];
		return await Promise.all(
			requests.map(async (q) => {
				const t = await get(`/v1/work/${encodeURIComponent(q.workId)}/record`)
					.then((x) => (x.ok ? (x.json() as Promise<{ title?: string }>) : undefined))
					.catch(() => undefined);
				return { ...q, title: t?.title ?? q.workId };
			}),
		);
	} catch {
		return [];
	}
}

const KEY = Symbol.for("wolfpack.console.workApprovals");
export function approvalsApi(env: Record<string, string | undefined> = process.env): ReturnType<typeof createApprovalsApi> {
	const h = globalThis as { [KEY]?: ReturnType<typeof createApprovalsApi> };
	return (h[KEY] ??= createApprovalsApi({ gate: (req) => healthApi(env).gate(req, "approval"), env }));
}
