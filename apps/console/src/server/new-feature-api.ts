/**
 * THE NEW FEATURE API: starts the work-creation flow on the named wolf. The request-scoped client carries the browser's own device
 * token; in relay mode the hub tunnels the call to the wolf's host, where wolfd resolves that wolf's prompts. The console never builds
 * or reads the prompt text.
 */
import type { ConsoleClient } from "@wolfpack/client";
import { HUB_AUTH_HEADER } from "../core/hub-auth.ts";
import { getConsoleClient } from "./console-client.ts";
import type { ClientSource } from "./thread-api.ts";

const STATUS_BY_CODE: Record<string, number> = { not_found: 404, unauthorized: 401, forbidden: 403, invalid_request: 400, busy: 409, conflict: 409 };
const json = (body: unknown, status = 200): Response => Response.json(body, { status });

function failure(err: unknown): Response {
	if (err instanceof Error && err.name === "NotFoundError") return json({ error: err.message, code: "not_found" }, 404);
	if (err instanceof Error && (err.name === "ProtocolError" || err.name === "BusyError")) {
		const e = err as Error & { code?: string; hubAuth?: boolean };
		const code = err.name === "BusyError" ? "busy" : (e.code ?? "engine_error");
		return Response.json({ error: err.message, code }, { status: STATUS_BY_CODE[code] ?? 502, ...(e.hubAuth === true ? { headers: { [HUB_AUTH_HEADER]: "required" } } : {}) });
	}
	console.error("[new-feature-api] unexpected error:", err);
	return json({ error: "Internal error" }, 500);
}

export function createNewFeatureApi(source: ClientSource) {
	return {
		async start(wolf: string, req: Request): Promise<Response> {
			const body = (await req.json().catch(() => ({}))) as { idea?: unknown } | null;
			const idea = typeof body?.idea === "string" && body.idea.trim() ? body.idea.trim() : undefined;
			try {
				const c: ConsoleClient = source();
				if (!c.newFeature) return json({ error: "new feature is not available on this console", code: "engine_error" }, 503);
				return json(await c.newFeature(wolf, idea));
			} catch (err) {
				return failure(err);
			}
		},
	};
}

export const newFeatureApi = (): ReturnType<typeof createNewFeatureApi> => createNewFeatureApi(getConsoleClient);
