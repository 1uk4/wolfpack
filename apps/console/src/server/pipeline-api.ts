/**
 * THE KB PIPELINE API: a thin Response-returning handler over a ConsoleClient
 * for GET /api/wolves/[name]/kb/pipeline. Same error mapping as memory-api.ts
 * (kb_unavailable is 409; a client without getKbPipeline answers 409 too).
 */

import { getConsoleClient } from "./console-client.ts";
import type { ClientSource } from "./thread-api.ts";

// Mirrors STATUS_BY_CODE / failure() in memory-api.ts (scaffold-owned, so not imported or edited here).
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
			return json({ error: err.message, code }, STATUS_BY_CODE[code] ?? 502);
		}
		console.error("[pipeline-api] unexpected error:", err);
	}
	return json({ error: "Internal error" }, 500);
}

export function createPipelineApi(source: ClientSource) {
	return {
		async kbPipeline(librarian: string): Promise<Response> {
			try {
				const client = source();
				if (!client.getKbPipeline) return json({ error: "the KB pipeline is not supported by this client", code: "kb_unavailable" }, 409);
				return json(await client.getKbPipeline(librarian));
			} catch (err) {
				return failure(err);
			}
		},
	};
}

/** The api bound to the process-wide console client. */
export function pipelineApi() {
	return createPipelineApi(getConsoleClient);
}
