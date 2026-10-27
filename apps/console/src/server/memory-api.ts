/**
 * THE MEMORY / KB API: thin Response-returning handlers over a ConsoleClient
 * for the memory-visibility surface (memory status/topics, work Records, the
 * KB graph + entries, promote/consolidate, and the wolf's memory SSE).
 * Same shape as thread-api.ts: the route files are one-line wrappers, tests
 * drive the handlers with a stub client.
 *
 * Errors: a ProtocolError maps from its `code` to the protocol's stable HTTP
 * status (memory_unavailable / promote_unavailable / memory_busy /
 * kb_unavailable are all 409) and the body is `{ error, code }`. The client's
 * memory/KB methods are optional on the ConsoleClient interface; a client
 * without one answers 409 with the area's "unavailable" code.
 *
 * The events bridge turns `client.watchMemory` into SSE: one `data: <json>`
 * frame per MemoryEvent plus a `: ping` comment every 25 s. There is no
 * resume (the client does not replay); EventSource's auto-reconnect picks the
 * live stream back up and consumers refetch truth.
 *
 * The KB pipeline handler is NOT here: the Pipeline task adds its own.
 */

import type { ConsoleClient } from "@wolfpack/client";
import { getConsoleClient } from "./console-client.ts";
import type { ClientSource } from "./thread-api.ts";

/** Mirrors the protocol's ERROR_HTTP_STATUS (clients map from `code`, never status). */
const STATUS_BY_CODE: Record<string, number> = {
	busy: 409,
	not_found: 404,
	unauthorized: 401,
	version_mismatch: 426,
	engine_error: 502,
	invalid_request: 400,
	memory_unavailable: 409,
	promote_unavailable: 409,
	memory_busy: 409,
	kb_unavailable: 409,
};

export const PING_INTERVAL_MS = 25_000;

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
		return json({ error: err.message }, 500);
	}
	return json({ error: "Unexpected error" }, 500);
}

const unsupported = (code: "memory_unavailable" | "kb_unavailable", what: string): Response =>
	json({ error: `${what} is not supported by this client`, code }, 409);

const flag = (v: string | null): boolean | undefined => (v === null ? undefined : v === "1" || v === "true");

export function createMemoryApi(source: ClientSource) {
	return {
		async memoryStatus(wolf: string, thread?: string): Promise<Response> {
			try {
				const client = source();
				if (!client.getMemoryStatus) return unsupported("memory_unavailable", "memory status");
				return json(await client.getMemoryStatus(wolf, thread ? { thread } : {}));
			} catch (err) {
				return failure(err);
			}
		},

		async memoryTopic(wolf: string, id: string, scope?: string | null): Promise<Response> {
			try {
				const client = source();
				if (!client.getMemoryTopic) return unsupported("memory_unavailable", "memory topics");
				const s = scope === "den" || scope === "session" ? scope : undefined;
				return json(await client.getMemoryTopic(wolf, id, s ? { scope: s } : {}));
			} catch (err) {
				return failure(err);
			}
		},

		async workRecord(wolf: string, id: string): Promise<Response> {
			try {
				const client = source();
				if (!client.getWorkRecord) return unsupported("memory_unavailable", "work records");
				return json(await client.getWorkRecord(wolf, id));
			} catch (err) {
				return failure(err);
			}
		},

		async consolidate(wolf: string): Promise<Response> {
			try {
				const client = source();
				if (!client.consolidateMemory) return unsupported("memory_unavailable", "consolidate");
				return json(await client.consolidateMemory(wolf));
			} catch (err) {
				return failure(err);
			}
		},

		async promote(wolf: string): Promise<Response> {
			try {
				const client = source();
				if (!client.promoteMemory) return unsupported("memory_unavailable", "promote");
				return json(await client.promoteMemory(wolf));
			} catch (err) {
				return failure(err);
			}
		},

		/** Query: `domain`, and the layer flags `archivedWork`, `wikilinks`, `denTopics` (`1`/`true`). */
		async kbGraph(librarian: string, params: URLSearchParams): Promise<Response> {
			try {
				const client = source();
				if (!client.getKbGraph) return unsupported("kb_unavailable", "the KB graph");
				const opts: Parameters<NonNullable<ConsoleClient["getKbGraph"]>>[1] = {};
				const domain = params.get("domain");
				if (domain) opts.domain = domain;
				for (const k of ["archivedWork", "wikilinks", "denTopics"] as const) {
					const v = flag(params.get(k));
					if (v !== undefined) opts[k] = v;
				}
				return json(await client.getKbGraph(librarian, opts));
			} catch (err) {
				return failure(err);
			}
		},

		async kbEntry(librarian: string, id: string): Promise<Response> {
			try {
				const client = source();
				if (!client.getKbEntry) return unsupported("kb_unavailable", "KB entries");
				return json(await client.getKbEntry(librarian, id));
			} catch (err) {
				return failure(err);
			}
		},

		/** SSE bridge over client.watchMemory: `data: <json>` frames + a `: ping` comment every 25 s. */
		events(wolf: string, req: Request): Response {
			let client: ConsoleClient;
			try {
				client = source();
			} catch (err) {
				return failure(err);
			}
			if (!client.watchMemory) return unsupported("memory_unavailable", "memory events");
			const watch = client.watchMemory.bind(client);
			const encoder = new TextEncoder();
			const abort = new AbortController();
			req.signal?.addEventListener("abort", () => abort.abort());
			let ping: ReturnType<typeof setInterval> | undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const safe = (chunk: string) => {
						try {
							controller.enqueue(encoder.encode(chunk));
						} catch {
							// closed
						}
					};
					safe(": open\n\n");
					ping = setInterval(() => safe(": ping\n\n"), PING_INTERVAL_MS);
					void (async () => {
						try {
							for await (const ev of watch(wolf, { signal: abort.signal })) safe(`data: ${JSON.stringify(ev)}\n\n`);
						} catch {
							// stream lost or aborted: close, EventSource reconnects
						} finally {
							clearInterval(ping);
							try {
								controller.close();
							} catch {
								// already closed
							}
						}
					})();
				},
				cancel() {
					clearInterval(ping);
					abort.abort();
				},
			});
			return new Response(body, {
				headers: {
					"Content-Type": "text/event-stream; charset=utf-8",
					"Cache-Control": "no-cache, no-transform",
					Connection: "keep-alive",
				},
			});
		},
	};
}

/** The api bound to the process-wide console client. */
export function memoryApi() {
	return createMemoryApi(getConsoleClient);
}
