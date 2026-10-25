/**
 * THE THREAD API: thin Response-returning handlers over a ConsoleClient.
 * The Next route files are one-line wrappers around these (the import law:
 * routes come through the server barrel; tests drive the handlers directly
 * with a MockConsoleClient — that seam is the point).
 *
 * Thread URLs carry a SLUG (core/thread-adapter.ts threadSlug), not the
 * client's raw id; every handler resolves slug → id through listThreads.
 *
 * The SSE stream bridges client.watch(): each ThreadEvent is one frame
 * (`id: <event id>` + `data: <json>`), terminated by `data: [DONE]`. A
 * reconnect resumes with the standard `Last-Event-ID` header (or `?from=`):
 * the client replays events with id > from, then follows live.
 */

import { NotFoundError, type ConsoleClient, type ThreadEvent, type WhenBusy } from "@wolfpack/client";
import { resolveThreadId } from "../core/thread-adapter.ts";
import { getConsoleClient } from "./console-client.ts";

export type ClientSource = () => ConsoleClient;

export interface ThreadRef {
	wolf: string;
	slug: string;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

// Errors are matched by NAME, not instanceof: Next bundles @wolfpack/client
// per route/page, so the class the client threw and the class imported here
// can be different copies of the same module.
const isError = (err: unknown, name: string): err is Error => err instanceof Error && err.name === name;
export const isNotFound = (err: unknown): err is Error => isError(err, "NotFoundError");
export const isBusy = (err: unknown): err is Error => isError(err, "BusyError");

function failure(err: unknown): Response {
	if (isNotFound(err)) return json({ error: err.message }, 404);
	if (isBusy(err)) return json({ error: err.message, code: "busy" }, 409);
	return json({ error: err instanceof Error ? err.message : "Unexpected error" }, 500);
}

async function resolve(client: ConsoleClient, ref: ThreadRef): Promise<string> {
	const threads = await client.listThreads(ref.wolf);
	const id = resolveThreadId(ref.wolf, ref.slug, threads);
	if (!id) throw new NotFoundError(`thread ${ref.slug}`);
	return id;
}

/** `Last-Event-ID` header, else `?from=`; anything non-numeric is ignored. */
export function resumeCursor(req: Request): number | undefined {
	const raw = req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("from");
	if (raw === null || raw.trim() === "") return undefined;
	const n = Number(raw);
	return Number.isInteger(n) && n >= 0 ? n : undefined;
}

const encoder = new TextEncoder();

export function sseFrame(ev: ThreadEvent): Uint8Array {
	return encoder.encode(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
}

const DONE = encoder.encode("data: [DONE]\n\n");

export function createThreadApi(source: ClientSource) {
	return {
		async wolves(): Promise<Response> {
			try {
				return json({ wolves: await source().listWolves() });
			} catch (err) {
				return failure(err);
			}
		},

		async threads(wolf: string): Promise<Response> {
			try {
				return json({ threads: await source().listThreads(wolf) });
			} catch (err) {
				return failure(err);
			}
		},

		async thread(ref: ThreadRef): Promise<Response> {
			try {
				const client = source();
				return json(await client.getThread(await resolve(client, ref)));
			} catch (err) {
				return failure(err);
			}
		},

		async submit(ref: ThreadRef, req: Request): Promise<Response> {
			try {
				const body = (await req.json().catch(() => null)) as { input?: unknown; whenBusy?: WhenBusy } | null;
				if (typeof body?.input !== "string" || body.input.trim() === "") {
					return json({ error: "input is required" }, 400);
				}
				const client = source();
				const ack = await client.submit(await resolve(client, ref), body.input, { whenBusy: body.whenBusy });
				return json(ack);
			} catch (err) {
				return failure(err);
			}
		},

		async abort(ref: ThreadRef): Promise<Response> {
			try {
				const client = source();
				await client.abort(await resolve(client, ref));
				return json({ ok: true });
			} catch (err) {
				return failure(err);
			}
		},

		async stream(ref: ThreadRef, req: Request): Promise<Response> {
			let iterator: AsyncIterator<ThreadEvent>;
			try {
				const client = source();
				const id = await resolve(client, ref);
				iterator = client.watch(id, {
					from: resumeCursor(req),
					// A snapshot only fires on a stale cursor. The bridge's SSE contract has no snapshot
					// frame yet (full snapshot UX is a later feature), so log and carry on with the events.
					onSnapshot: (snap) => console.warn(`[thread-api] snapshot baseline for ${id} (stale cursor ${snap.id ?? "?"}); not forwarded`),
				})[Symbol.asyncIterator]();
			} catch (err) {
				return failure(err);
			}
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					try {
						const next = await iterator.next();
						if (next.done) {
							controller.enqueue(DONE);
							controller.close();
							return;
						}
						controller.enqueue(sseFrame(next.value));
					} catch (err) {
						controller.error(err);
					}
				},
				async cancel() {
					await iterator.return?.();
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
export function threadApi() {
	return createThreadApi(getConsoleClient);
}
