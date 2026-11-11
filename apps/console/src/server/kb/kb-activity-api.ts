/**
 * THE KB ACTIVITY API: a thin Response-returning handler over a ConsoleClient for GET /api/kb/activity (the hub's GET /v1/kb/activity).
 * Same error mapping as memory-api.ts; a client without getKbActivity (no hub) answers 409 kb_unavailable. The query
 * (since, before, limit, domain) passes through; the hub validates it.
 */

import { HUB_AUTH_HEADER } from "../../core/hub-auth.ts";
import { getConsoleClient } from "../console-client.ts";
import type { ClientSource } from "../thread-api.ts";

const STATUS_BY_CODE: Record<string, number> = {
	busy: 409,
	not_found: 404,
	unauthorized: 401,
	version_mismatch: 426,
	engine_error: 502,
	invalid_request: 400,
	kb_unavailable: 409,
};

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

// Matched by NAME (Next bundles @wolfpack/client per route; instanceof is unreliable).
function failure(err: unknown): Response {
	if (err instanceof Error) {
		if (err.name === "NotFoundError") return json({ error: err.message, code: "not_found" }, 404);
		if (err.name === "BusyError") return json({ error: err.message, code: "busy" }, 409);
		if (err.name === "ProtocolError") {
			const code = (err as Error & { code?: string }).code ?? "engine_error";
			// A hub-auth 401 is marked so the browser signs out (as memory-api / devices-api do); other 401s are not its token's fault.
			const hubAuth = (err as Error & { hubAuth?: boolean }).hubAuth === true;
			return Response.json({ error: err.message, code }, { status: STATUS_BY_CODE[code] ?? 502, ...(hubAuth ? { headers: { [HUB_AUTH_HEADER]: "required" } } : {}) });
		}
		console.error("[kb-activity-api] unexpected error:", err);
	}
	return json({ error: "Internal error" }, 500);
}

export function createKbActivityApi(source: ClientSource) {
	return {
		async kbActivity(params: URLSearchParams = new URLSearchParams()): Promise<Response> {
			try {
				const client = source();
				if (!client.getKbActivity) return json({ error: "KB activity needs a hub", code: "kb_unavailable" }, 409);
				const query: { since?: string; before?: string; limit?: number; domain?: string } = {};
				const since = params.get("since");
				const before = params.get("before");
				const domain = params.get("domain");
				const limit = params.get("limit");
				if (since) query.since = since;
				if (before) query.before = before;
				if (domain) query.domain = domain;
				if (limit !== null && limit !== "") {
					const n = Number(limit);
					if (!Number.isInteger(n)) return json({ error: "limit must be an integer", code: "invalid_request" }, 400);
					query.limit = n;
				}
				return json(await client.getKbActivity(query));
			} catch (err) {
				return failure(err);
			}
		},
	};
}

/** The api bound to the process-wide console client. */
export function kbActivityApi() {
	return createKbActivityApi(getConsoleClient);
}
