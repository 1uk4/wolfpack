/**
 * THE PROMPTS API: thin Response-returning handlers over a ConsoleClient for the Prompts page (list, save with If-Match, reset).
 * Same shape as memory-api.ts: the route files are one-line wrappers, tests drive the handlers with a stub client. The client is the
 * request-scoped one (getConsoleClient), so in relay mode every call carries the browser's own device token to the hub, which tunnels
 * it to the wolf's host. Errors keep the protocol's stable status per `code`: 403 forbidden (not wolf-editable), 404, 409 conflict
 * (stale etag), 413 too_large, 401 with the hub-auth marker for an unpaired browser.
 */
import type { ConsoleClient } from "@wolfpack/client";
import { HUB_AUTH_HEADER } from "../../core/hub-auth.ts";
import { getConsoleClient } from "../thread/console-client.ts";
import type { ClientSource } from "../thread/thread-api.ts";

const STATUS_BY_CODE: Record<string, number> = {
	not_found: 404,
	unauthorized: 401,
	forbidden: 403,
	invalid_request: 400,
	conflict: 409,
	too_large: 413,
	version_mismatch: 426,
	engine_error: 502,
};

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

function failure(err: unknown): Response {
	if (err instanceof Error && err.name === "NotFoundError") return json({ error: err.message, code: "not_found" }, 404);
	if (err instanceof Error && err.name === "ProtocolError") {
		const code = (err as Error & { code?: string }).code ?? "engine_error";
		const hubAuth = (err as Error & { hubAuth?: boolean }).hubAuth === true;
		const timedOut = (err as Error & { timedOut?: boolean }).timedOut === true; // the client gave up waiting: 504, not 502
		return Response.json({ error: err.message, code }, { status: timedOut ? 504 : (STATUS_BY_CODE[code] ?? 502), ...(hubAuth ? { headers: { [HUB_AUTH_HEADER]: "required" } } : {}) });
	}
	console.error("[prompts-api] unexpected error:", err);
	return json({ error: "Internal error" }, 500);
}

const unsupported = (): Response => json({ error: "prompts are not available on this console (no wolf or hub configured)", code: "engine_error" }, 503);

export function createPromptsApi(source: ClientSource) {
	const run = async (fn: (c: ConsoleClient) => Promise<Response>): Promise<Response> => {
		try {
			return await fn(source());
		} catch (err) {
			return failure(err);
		}
	};
	return {
		list: (wolf: string) => run(async (c) => (c.listPrompts ? json({ prompts: await c.listPrompts(wolf) }) : unsupported())),
		async save(wolf: string, id: string, req: Request): Promise<Response> {
			const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
			if (!body || typeof body.text !== "string") return json({ error: "body must be {text: string}", code: "invalid_request" }, 400);
			const text = body.text;
			const ifMatch = req.headers.get("if-match");
			if (!ifMatch) return json({ error: "If-Match is required: send the etag of the prompt you loaded", code: "invalid_request" }, 400);
			return run(async (c) => (c.putPrompt ? json(await c.putPrompt(wolf, id, text, ifMatch)) : unsupported()));
		},
		reset: (wolf: string, id: string, req: Request) => {
			const ifMatch = req.headers.get("if-match");
			if (!ifMatch) return Promise.resolve(json({ error: "If-Match is required: send the etag of the prompt you loaded", code: "invalid_request" }, 400));
			return run(async (c) => (c.resetPrompt ? json(await c.resetPrompt(wolf, id, ifMatch)) : unsupported()));
		},
	};
}

export const promptsApi = (): ReturnType<typeof createPromptsApi> => createPromptsApi(getConsoleClient);
