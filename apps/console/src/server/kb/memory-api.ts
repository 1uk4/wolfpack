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
import { HUB_AUTH_HEADER } from "../../core/hub-auth.ts";
import { findKbSource } from "../../core/kb/kb.ts";
import { getConsoleClient } from "../thread/console-client.ts";
import type { ClientSource } from "../thread/thread-api.ts";

/** Mirrors the protocol's ERROR_HTTP_STATUS (clients map from `code`, never status). */
const STATUS_BY_CODE: Record<string, number> = {
	busy: 409,
	not_found: 404,
	unauthorized: 401,
	forbidden: 403,
	version_mismatch: 426,
	engine_error: 502,
	invalid_request: 400,
	memory_unavailable: 409,
	promote_unavailable: 409,
	memory_busy: 409,
	kb_unavailable: 409,
	thread_closed: 409,
	not_ready: 409,
	preview_stale: 409,
	conflict: 409,
};

export const PING_INTERVAL_MS = 25_000;
/** How long the events bridge waits for an immediate watchMemory failure before answering 200. */
export const FIRST_PULL_MS = 250;
const MAX_BACKLOG = 256;

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** The protocol code of a ProtocolError (matched by name), else null. */
function errorCode(err: unknown): string | null {
	return err instanceof Error && err.name === "ProtocolError" ? ((err as Error & { code?: string }).code ?? "engine_error") : null;
}

// Matched by NAME (Next bundles @wolfpack/client per route; instanceof is unreliable).
function failure(err: unknown): Response {
	if (err instanceof Error) {
		if (err.name === "NotFoundError") return json({ error: err.message, code: "not_found" }, 404);
		if (err.name === "BusyError") {
			const details = (err as Error & { details?: Record<string, string> }).details;
			return json({ error: err.message, code: "busy", ...(details ? { details } : {}) }, 409);
		}
		if (err.name === "ProtocolError") {
			const code = (err as Error & { code?: string }).code ?? "engine_error";
			// A hub-auth 401 (HubAuthError) is marked so the browser signs out; other 401s (a wolf host) are not its token's fault.
			const hubAuth = (err as Error & { hubAuth?: boolean }).hubAuth === true;
			return Response.json({ error: err.message, code }, { status: STATUS_BY_CODE[code] ?? 502, ...(hubAuth ? { headers: { [HUB_AUTH_HEADER]: "required" } } : {}) });
		}
		console.error("[memory-api] unexpected error:", err);
	}
	return json({ error: "Internal error" }, 500);
}

const unsupported = (code: "memory_unavailable" | "kb_unavailable", what: string): Response =>
	json({ error: `${what} is not supported by this client`, code }, 409);

const WORK_ID_RE = /^work-[a-z0-9-]+-[A-Za-z0-9]+$/;

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

		async memoryObservations(wolf: string, limit?: string | null): Promise<Response> {
			try {
				const client = source();
				if (!client.getMemoryObservations) return unsupported("memory_unavailable", "memory observations");
				if (limit && !/^[1-9]\d{0,6}$/.test(limit)) return json({ error: "limit must be a positive integer", code: "invalid_request" }, 400);
				return json(await client.getMemoryObservations(wolf, limit ? { limit: Number(limit) } : {}));
			} catch (err) {
				return failure(err);
			}
		},

		async memoryTree(wolf: string): Promise<Response> {
			try {
				const client = source();
				if (!client.getMemoryTree) return unsupported("memory_unavailable", "memory tree");
				return json(await client.getMemoryTree(wolf));
			} catch (err) {
				return failure(err);
			}
		},

		async memoryNode(wolf: string, workId: string, limit?: string | null): Promise<Response> {
			try {
				const client = source();
				if (!client.getMemoryNodeObservations) return unsupported("memory_unavailable", "memory tree");
				if (limit && !/^[1-9]\d{0,6}$/.test(limit)) return json({ error: "limit must be a positive integer", code: "invalid_request" }, 400);
				return json(await client.getMemoryNodeObservations(wolf, workId, limit ? { limit: Number(limit) } : {}));
			} catch (err) {
				return failure(err);
			}
		},

		async memoryTopic(wolf: string, id: string, scope?: string | null): Promise<Response> {
			try {
				const client = source();
				if (!client.getMemoryTopic) return unsupported("memory_unavailable", "memory topics");
				if (scope && scope !== "den" && scope !== "session") {
					return json({ error: "scope must be den or session", code: "invalid_request" }, 400);
				}
				return json(await client.getMemoryTopic(wolf, id, scope ? { scope: scope as "den" | "session" } : {}));
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

		async workList(wolf: string, domain: string | null, graduated: boolean): Promise<Response> {
			try {
				const client = source();
				if (!client.listWork) return unsupported("memory_unavailable", "work lists");
				if (!domain) return json({ error: "domain is required", code: "invalid_request" }, 400);
				return json(await client.listWork(wolf, { domain, graduated }));
			} catch (err) {
				return failure(err);
			}
		},

		/**
		 * Owner work ops, a thin pass-through to the hub's PATCH: exactly one of `{assignee: "<wolf>"}` or `{moveTo: "<id>"|null}`.
		 * Anything else is refused here (400) without calling the hub; the hub's own refusals come back with its message.
		 * An assignee must be in the same wolf list the dropdown reads (`listWolves`, which the hub already limits to non-retired wolves; it
		 * exposes no retired flag). That is only a guard: the hub's `knownWolf` check is the real gate (the hub deployed today does not have it).
		 * It fails closed: no list, or an empty one, refuses the assign without calling the hub.
		 */
		async workOp(id: string, body: unknown): Promise<Response> {
			try {
				if (!WORK_ID_RE.test(id)) return json({ error: "malformed work item id", code: "invalid_request" }, 400);
				const keys = typeof body === "object" && body !== null && !Array.isArray(body) ? Object.keys(body) : [];
				const b = (body ?? {}) as { assignee?: unknown; moveTo?: unknown };
				const ok = keys.length === 1 && ((keys[0] === "assignee" && typeof b.assignee === "string" && b.assignee !== "") || (keys[0] === "moveTo" && (b.moveTo === null || (typeof b.moveTo === "string" && b.moveTo !== ""))));
				if (!ok) return json({ error: "body must be {assignee} or {moveTo}", code: "invalid_request" }, 400);
				const client = source();
				if (!client.patchWork) return unsupported("memory_unavailable", "work changes");
				if (keys[0] === "assignee") {
					const wolves = (await client.listWolves()).map((w) => w.name);
					if (wolves.length === 0) return json({ error: "hub unreachable: no wolves known", code: "engine_error" }, 502);
					if (!wolves.includes(b.assignee as string)) return json({ error: `unknown assignee "${String(b.assignee).slice(0, 64)}": not a wolf known to this hub`, code: "invalid_request" }, 400);
				}
				return json(await client.patchWork(id, keys[0] === "assignee" ? { assignee: b.assignee as string } : { moveTo: b.moveTo as string | null }));
			} catch (err) {
				// A fetch that never got an answer is a plain Error (not a ProtocolError): say the hub is unreachable, not "Internal error".
				if (err instanceof Error && err.name !== "ProtocolError" && err.name !== "NotFoundError" && err.name !== "BusyError") return json({ error: "hub unreachable", code: "engine_error" }, 502);
				return failure(err);
			}
		},

		/** Graduation step 1: start the background preview job (answers the running job at once). Nothing is sent or archived. */
		async graduatePreview(wolf: string, id: string): Promise<Response> {
			try {
				const client = source();
				if (!client.startGraduationPreview) return unsupported("memory_unavailable", "graduation");
				return json(await client.startGraduationPreview(wolf, id));
			} catch (err) {
				return failure(err);
			}
		},

		/** Graduation step 2: start the background confirm job (answers the running job at once). `body` is the request's JSON, `{token}`. */
		async graduateConfirm(wolf: string, id: string, body: unknown): Promise<Response> {
			try {
				const client = source();
				if (!client.startGraduationConfirm) return unsupported("memory_unavailable", "graduation");
				const token = typeof body === "object" && body !== null ? (body as { token?: unknown }).token : undefined;
				if (typeof token !== "string" || !token) return json({ error: "body must be {token}", code: "invalid_request" }, 400);
				return json(await client.startGraduationConfirm(wolf, id, token));
			} catch (err) {
				return failure(err);
			}
		},

		/** Where the item's graduation job stands (none, running, preview_ready, graduated, error). */
		async graduateStatus(wolf: string, id: string): Promise<Response> {
			try {
				const client = source();
				if (!client.graduationStatus) return unsupported("memory_unavailable", "graduation");
				return json(await client.graduationStatus(wolf, id));
			} catch (err) {
				return failure(err);
			}
		},

		/** The pending observations a graduation of the item would fold, per task. */
		async graduateObservations(wolf: string, id: string): Promise<Response> {
			try {
				const client = source();
				if (!client.graduationObservations) return unsupported("memory_unavailable", "graduation");
				return json(await client.graduationObservations(wolf, id));
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

		/** Query: `domain`, and the layer flags `archivedWork`, `denTopics` (`1`/`true`). */
		async kbGraph(librarian: string, params: URLSearchParams): Promise<Response> {
			try {
				const client = source();
				if (!client.getKbGraph) return unsupported("kb_unavailable", "the KB graph");
				const opts: Parameters<NonNullable<ConsoleClient["getKbGraph"]>>[1] = {};
				const domain = params.get("domain");
				if (domain) opts.domain = domain;
				for (const k of ["archivedWork", "denTopics"] as const) {
					const v = flag(params.get(k));
					if (v !== undefined) opts[k] = v;
				}
				return json(await client.getKbGraph(librarian, opts));
			} catch (err) {
				return failure(err);
			}
		},

		/**
		 * The graph for the browser, source chosen HERE: relay mode (hub serves it from its KB copy, token-scoped) needs no KB wolf;
		 * otherwise the first wolf that can read the KB (librarian, else a mirror), exactly as the browser used to pick.
		 */
		async kbGraphAuto(params: URLSearchParams): Promise<Response> {
			try {
				const client = source();
				if (client.kbFromHub && client.getHubKbGraph) {
					const opts: { domain?: string; archivedWork?: boolean } = {};
					const domain = params.get("domain");
					if (domain) opts.domain = domain;
					const aw = flag(params.get("archivedWork"));
					if (aw !== undefined) opts.archivedWork = aw;
					return json({ ...(await client.getHubKbGraph(opts)), hubCopy: true });
				}
				if (!client.getKbGraph) return unsupported("kb_unavailable", "the KB graph");
				const kb = findKbSource(await client.listWolves());
				if (!kb) return json({ error: "no wolf can read the knowledge base", code: "kb_unavailable" }, 409);
				return await this.kbGraph(kb.name, params);
			} catch (err) {
				return failure(err);
			}
		},

		/** Entry for the browser: relay mode reads the hub's KB copy (token-scoped); local mode finds a KB wolf exactly as the browser used to. */
		async kbEntryAuto(id: string): Promise<Response> {
			try {
				const client = source();
				if (client.kbFromHub && client.getHubKbEntry) return json(await client.getHubKbEntry(id));
				if (!client.getKbEntry) return unsupported("kb_unavailable", "KB entries");
				const kb = findKbSource(await client.listWolves());
				if (!kb) return json({ error: "no wolf can read the knowledge base", code: "kb_unavailable" }, 409);
				return json(await client.getKbEntry(kb.name, id));
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

		/**
		 * SSE bridge over client.watchMemory: `data: <json>` frames + a `: ping` comment every 25 s.
		 * watchMemory is lazy (errors surface on the first next()), so the first pull is raced against
		 * FIRST_PULL_MS: an immediate failure becomes the mapped non-200 response (the browser's hub backs
		 * off on it); a quiet stream proceeds as a 200. A mid-stream error is a terminal `event: error`
		 * frame carrying `{code, message}`, then the stream closes.
		 *
		 * HUB AUTH: this stream (and /api/events) is read by EventSource, which cannot send a bearer header, and it talks to the
		 * WOLF host only (watchMemory), never the hub. Do NOT add a hub call here: it would have no browser token. Hub reads go
		 * through requestScopedWork, which rejects (401) without a forwarded token; a hub stream needs fetch-based streaming.
		 */
		async events(wolf: string, req: Request): Promise<Response> {
			if (req.signal?.aborted) return new Response(null, { status: 204 });
			let client: ConsoleClient;
			try {
				client = source();
			} catch (err) {
				return failure(err);
			}
			if (!client.watchMemory) return unsupported("memory_unavailable", "memory events");
			const abort = new AbortController();
			const onAbort = () => abort.abort();
			req.signal?.addEventListener("abort", onAbort);
			const cleanup = () => req.signal?.removeEventListener("abort", onAbort);
			const iterator = client.watchMemory(wolf, { signal: abort.signal })[Symbol.asyncIterator]();
			let first = iterator.next();
			const early = await Promise.race([
				first.then(
					() => null,
					(err: unknown) => ({ err }),
				),
				new Promise<null>((resolve) => setTimeout(() => resolve(null), FIRST_PULL_MS)),
			]);
			if (early) {
				cleanup();
				abort.abort();
				return failure(early.err);
			}
			const encoder = new TextEncoder();
			let ping: ReturnType<typeof setInterval> | undefined;
			let finished = false;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					const finish = () => {
						if (finished) return;
						finished = true;
						clearInterval(ping);
						cleanup();
						abort.abort();
						try {
							controller.close();
						} catch {
							// already closed
						}
					};
					const send = (chunk: string) => {
						if (finished) return;
						// A consumer that stopped reading must not buffer forever.
						if ((controller.desiredSize ?? 0) < -MAX_BACKLOG) return finish();
						try {
							controller.enqueue(encoder.encode(chunk));
						} catch {
							finish();
						}
					};
					send(": open\n\n");
					ping = setInterval(() => send(": ping\n\n"), PING_INTERVAL_MS);
					void (async () => {
						try {
							for (;;) {
								const next = await first;
								if (next.done) break;
								send(`data: ${JSON.stringify(next.value)}\n\n`);
								if (finished) return;
								first = iterator.next();
							}
						} catch (err) {
							if (!abort.signal.aborted) {
								const code = errorCode(err);
								if (!code) console.error("[memory-api] watchMemory failed:", err);
								const payload = { code: code ?? "engine_error", message: code ? (err as Error).message : "Internal error" };
								send(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
							}
						}
						finish();
					})();
				},
				cancel() {
					finished = true;
					clearInterval(ping);
					cleanup();
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
