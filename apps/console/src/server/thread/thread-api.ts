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

import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_PER_SUBMIT, ATTACHMENT_NAME_HEADER, NotFoundError, type AttachmentRef, type CardAnswers, type ConsoleClient, type SnapshotEvent, type ThreadEvent, type WhenBusy } from "@wolfpack/client";
import { DIAGRAM_ID_RE } from "@wolfpack/protocol";
import { ATTACHMENT_IMAGE_TYPES } from "@wolfpack/protocol/attachments";
import { HUB_AUTH_HEADER } from "../../core/ui/hub-auth.ts";
import { resolveThreadId } from "../../core/thread/thread-adapter.ts";
import { workspaceGraph } from "./branch-graph.ts";
import { getConsoleClient } from "./console-client.ts";

export type ClientSource = () => ConsoleClient;

export interface ThreadRef {
	wolf: string;
	slug: string;
}

class TooLarge extends Error {}

/** Attachment ids are opaque tokens (wolf UUIDs, mock `att-N`): never a path. */
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Read a request body, giving up (and cancelling the stream) once it passes `max` bytes. */
async function readBounded(req: Request, max: number): Promise<Uint8Array> {
	if (!req.body) return new Uint8Array(0);
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let n = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		n += value.byteLength;
		if (n > max) {
			await reader.cancel().catch(() => {});
			throw new TooLarge(`attachment too large (limit ${max} bytes)`);
		}
		chunks.push(value);
	}
	const out = new Uint8Array(n);
	let at = 0;
	for (const c of chunks) {
		out.set(c, at);
		at += c.byteLength;
	}
	return out;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A card note off the wire: `{text?, attachments?}`; null when malformed. */
function parseNote(v: unknown): { text?: string; attachments?: string[] } | null {
	if (!isRecord(v)) return null;
	if (v.text !== undefined && typeof v.text !== "string") return null;
	if (v.attachments !== undefined && (!Array.isArray(v.attachments) || v.attachments.some((a) => typeof a !== "string"))) return null;
	return { ...(v.text !== undefined ? { text: v.text as string } : {}), ...(v.attachments !== undefined ? { attachments: v.attachments as string[] } : {}) };
}

// Errors are matched by NAME, not instanceof: Next bundles @wolfpack/client
// per route/page, so the class the client threw and the class imported here
// can be different copies of the same module.
const isError = (err: unknown, name: string): err is Error => err instanceof Error && err.name === name;
export const isNotFound = (err: unknown): err is Error => isError(err, "NotFoundError");
export const isBusy = (err: unknown): err is Error => isError(err, "BusyError");

function failure(err: unknown): Response {
	if (err instanceof TooLarge) return json({ error: err.message }, 413);
	if (isNotFound(err)) return json({ error: err.message }, 404);
	// Relay mode: a missing/revoked browser token is a HubAuthError (name ProtocolError, code unauthorized, hubAuth): 401 + the marker, so the browser goes to /pair.
	if (isError(err, "ProtocolError") && (err as Error & { hubAuth?: boolean }).hubAuth === true) return Response.json({ error: err.message, code: "unauthorized" }, { status: 401, headers: { [HUB_AUTH_HEADER]: "required" } });
	if (isBusy(err)) return json({ error: err.message, code: "busy" }, 409);
	// A refusal the user can act on (unsupported type, too large, unknown attachment).
	if (isError(err, "ProtocolError") && (err as Error & { code?: string }).code === "invalid_request") return json({ error: err.message }, 400);
	if (isError(err, "ProtocolError") && (err as Error & { code?: string }).code === "conflict") return json({ error: err.message, code: "conflict" }, 409);
	if (isError(err, "ProtocolError") && (err as Error & { code?: string }).code === "thread_closed") return json({ error: err.message, code: "thread_closed" }, 409);
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

export function sseFrame(ev: ThreadEvent | SnapshotEvent): Uint8Array {
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

		/** The subagent threads a thread spawned. A client without subagents has none (an empty list, not an error). */
		async children(ref: ThreadRef): Promise<Response> {
			try {
				const client = source();
				const id = await resolve(client, ref);
				return json({ threads: client.listChildren ? await client.listChildren(id) : [] });
			} catch (err) {
				return failure(err);
			}
		},

		/** Open a thread on a wolf: today only a feature thread (`{kind:"feature", workItemId}`), bound to that feature. */
		async createThread(wolf: string, req: Request): Promise<Response> {
			try {
				const body = (await req.json().catch(() => null)) as { kind?: unknown; workItemId?: unknown } | null;
				if (body?.kind !== "feature" || typeof body.workItemId !== "string" || body.workItemId === "") {
					return json({ error: 'body must be {kind:"feature", workItemId}' }, 400);
				}
				const client = source();
				if (!client.createThread) return json({ error: "this wolf cannot open feature threads" }, 501);
				return json(await client.createThread(wolf, { kind: "feature", workItemId: body.workItemId }));
			} catch (err) {
				return failure(err);
			}
		},

		async thread(ref: ThreadRef, opts: { limit?: number; before?: string } = {}): Promise<Response> {
			try {
				const client = source();
				return json(await client.getThread(await resolve(client, ref), opts));
			} catch (err) {
				return failure(err);
			}
		},

		async submit(ref: ThreadRef, req: Request): Promise<Response> {
			try {
				const body = (await req.json().catch(() => null)) as { input?: unknown; whenBusy?: WhenBusy; attachments?: unknown } | null;
				let attachments: AttachmentRef[] = [];
				if (body?.attachments !== undefined) {
					const list = body.attachments;
					if (
						!Array.isArray(list) ||
						list.length > ATTACHMENT_MAX_PER_SUBMIT ||
						!list.every((a) => typeof (a as AttachmentRef | null)?.id === "string")
					) {
						return json({ error: `attachments must be up to ${ATTACHMENT_MAX_PER_SUBMIT} {id: string} refs` }, 400);
					}
					attachments = list.map((a: AttachmentRef) => ({ id: a.id }));
				}
				if (typeof body?.input !== "string" || (body.input.trim() === "" && attachments.length === 0)) {
					return json({ error: "input is required" }, 400);
				}
				const client = source();
				const ack = await client.submit(await resolve(client, ref), body.input, { whenBusy: body.whenBusy, attachments });
				return json(ack);
			} catch (err) {
				return failure(err);
			}
		},

		/** The raw bytes are relayed to the thread's wolf (never stored here): the wolf the thread lives on keeps the file. */
		async upload(ref: ThreadRef, req: Request): Promise<Response> {
			try {
				const mimeType = req.headers.get("content-type") ?? "";
				const declared = Number(req.headers.get("content-length"));
				if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) {
					await req.body?.cancel().catch(() => {});
					throw new TooLarge(`attachment too large (limit ${ATTACHMENT_MAX_BYTES} bytes)`);
				}
				const raw = req.headers.get(ATTACHMENT_NAME_HEADER);
				let name: string | undefined;
				try {
					name = raw ? decodeURIComponent(raw) : undefined;
				} catch {
					name = undefined;
				}
				const bytes = await readBounded(req, ATTACHMENT_MAX_BYTES);
				const client = source();
				return json(await client.uploadAttachment(await resolve(client, ref), bytes, { mimeType, name }), 201);
			} catch (err) {
				return failure(err);
			}
		},

		/**
		 * The bytes of one attachment, relayed from the thread's wolf. The id is validated (opaque ids only: no
		 * separators or dots) before it goes anywhere, only image types are served, and the response is sniff-proof
		 * and sandboxed so a stored file can never run as a page on the console's origin.
		 */
		async attachment(ref: ThreadRef, attachmentId: string): Promise<Response> {
			try {
				if (!ATTACHMENT_ID.test(attachmentId)) return json({ error: "unknown attachment" }, 404);
				const client = source();
				const { bytes, mimeType } = await client.getAttachment(await resolve(client, ref), attachmentId);
				const mime = mimeType.split(";")[0]!.trim().toLowerCase();
				if (!(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(mime)) return json({ error: "unknown attachment" }, 404);
				return new Response(bytes as BodyInit, {
					headers: {
						"Content-Type": mime,
						"Content-Length": String(bytes.byteLength),
						"X-Content-Type-Options": "nosniff",
						"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
						"Cache-Control": "private, max-age=31536000, immutable",
					},
				});
			} catch (err) {
				return failure(err);
			}
		},

		/**
		 * The bytes of one question diagram (an `ask` field's `diagram` id), relayed from the thread's wolf: opaque ids only,
		 * images only, served sandboxed like attachments. 404 when the wolf has none (or cannot serve diagrams).
		 */
		async diagram(ref: ThreadRef, diagramId: string): Promise<Response> {
			try {
				if (!DIAGRAM_ID_RE.test(diagramId)) return json({ error: "unknown diagram" }, 404);
				const client = source();
				if (!client.getDiagram) return json({ error: "unknown diagram" }, 404);
				const { bytes, mimeType } = await client.getDiagram(await resolve(client, ref), diagramId);
				const mime = mimeType.split(";")[0]!.trim().toLowerCase();
				if (mime !== "image/png") return json({ error: "unknown diagram" }, 404);
				return new Response(bytes as BodyInit, {
					headers: {
						"Content-Type": mime,
						"Content-Length": String(bytes.byteLength),
						"X-Content-Type-Options": "nosniff",
						"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
						"Cache-Control": "private, max-age=31536000, immutable",
					},
				});
			} catch (err) {
				return failure(err);
			}
		},

		/** Answer a pending card: the console's side of `POST /v1/threads/:id/cards/:callId/answer`. */
		async answerCard(ref: ThreadRef, callId: string, req: Request): Promise<Response> {
			try {
				const body = (await req.json().catch(() => null)) as { answers?: unknown } | null;
				if (!body || typeof body.answers !== "object" || body.answers === null || Array.isArray(body.answers)) {
					return json({ error: "answers is required" }, 400);
				}
				const client = source();
				if (!client.answerCard) return json({ error: "this client has no cards" }, 501);
				return json(await client.answerCard(await resolve(client, ref), callId, body.answers as CardAnswers));
			} catch (err) {
				return failure(err);
			}
		},

		/** Save one page of a paged `ask` as a draft and move the cursor: `PUT /v1/threads/:id/cards/:callId/pages/:page/draft`. 409 `conflict` = the questions changed. */
		async saveCardPage(ref: ThreadRef, callId: string, page: string, req: Request): Promise<Response> {
			try {
				const body = (await req.json().catch(() => null)) as { answers?: unknown; goto?: unknown; stepsKey?: unknown } | null;
				const n = Number(page);
				if (!Number.isInteger(n) || n < 0) return json({ error: "page must be a non-negative integer" }, 400);
				if (!body || !isRecord(body.answers)) return json({ error: "answers is required" }, 400);
				if (body.goto !== undefined && (typeof body.goto !== "number" || !Number.isInteger(body.goto) || body.goto < 0)) return json({ error: "goto must be a non-negative integer" }, 400);
				if (body.stepsKey !== undefined && typeof body.stepsKey !== "string") return json({ error: "stepsKey must be a string" }, 400);
				const client = source();
				if (!client.saveCardPage) return json({ error: "this client has no paged cards" }, 501);
				await client.saveCardPage(await resolve(client, ref), callId, n, body.answers as CardAnswers, { ...(body.goto !== undefined ? { goto: body.goto as number } : {}), ...(body.stepsKey !== undefined ? { stepsKey: body.stepsKey as string } : {}) });
				return json({ accepted: true });
			} catch (err) {
				return failure(err);
			}
		},

		/** Submit a paged `ask` once (current page's answers + the note): `POST /v1/threads/:id/cards/:callId/submit`. */
		async submitCard(ref: ThreadRef, callId: string, req: Request): Promise<Response> {
			try {
				const body = (await req.json().catch(() => null)) as { answers?: unknown; note?: unknown; stepsKey?: unknown } | null;
				if (!body) return json({ error: "a JSON body is required" }, 400);
				if (body.answers !== undefined && !isRecord(body.answers)) return json({ error: "answers must be an object" }, 400);
				const note = body.note === undefined ? undefined : parseNote(body.note);
				if (note === null) return json({ error: "note must be {text?, attachments?}" }, 400);
				if (body.stepsKey !== undefined && typeof body.stepsKey !== "string") return json({ error: "stepsKey must be a string" }, 400);
				const client = source();
				if (!client.submitCard) return json({ error: "this client has no paged cards" }, 501);
				return json(await client.submitCard(await resolve(client, ref), callId, { ...(body.answers !== undefined ? { answers: body.answers as CardAnswers } : {}), ...(note ? { note } : {}), ...(body.stepsKey !== undefined ? { stepsKey: body.stepsKey as string } : {}) }));
			} catch (err) {
				return failure(err);
			}
		},

		/** Store the note typed beside an open questionnaire (an empty note clears it): `PUT /v1/threads/:id/cards/:callId/note`. */
		async putCardNote(ref: ThreadRef, callId: string, req: Request): Promise<Response> {
			try {
				const body = (await req.json().catch(() => null)) as unknown;
				const note = parseNote(body);
				if (note === null) return json({ error: "note must be {text?, attachments?}" }, 400);
				if ((note.text ?? "").length > 4000) return json({ error: "note text is limited to 4000 characters" }, 400);
				const client = source();
				if (!client.putCardNote) return json({ error: "this client has no paged cards" }, 501);
				await client.putCardNote(await resolve(client, ref), callId, note);
				return json({ accepted: true });
			} catch (err) {
				return failure(err);
			}
		},

		/** "Answering Qn": hold typed text as question `qid`'s answer (not a chat message): `POST .../questions/:qid/text`. */
		async bindCardText(ref: ThreadRef, callId: string, qid: string, req: Request): Promise<Response> {
			try {
				const body = (await req.json().catch(() => null)) as { text?: unknown; attachments?: unknown; picked?: unknown; others?: unknown; stepsKey?: unknown } | null;
				if (!body) return json({ error: "text or attachments is required" }, 400);
				if (body.stepsKey !== undefined && typeof body.stepsKey !== "string") return json({ error: "stepsKey must be a string" }, 400);
				const key = body.stepsKey as string | undefined;
				const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
				// A multi question's whole picked/custom list (replaces its draft); `text` is not used then.
				if (body.others !== undefined) {
					if (!strings(body.others) || (body.picked !== undefined && !strings(body.picked))) return json({ error: "picked and others must be lists of strings" }, 400);
					const multi = { picked: (body.picked as string[] | undefined) ?? [], others: body.others };
					const atts = Array.isArray(body.attachments) && body.attachments.every((a) => typeof a === "string") ? (body.attachments as string[]) : [];
					const c = source();
					if (!c.bindCardText) return json({ error: "this client has no paged cards" }, 501);
					await c.bindCardText(await resolve(c, ref), callId, qid, "", atts.length ? atts : undefined, multi, key);
					return json({ accepted: true });
				}
				if (body.text !== undefined && typeof body.text !== "string") return json({ error: "text must be a string" }, 400);
				if (body.attachments !== undefined && (!Array.isArray(body.attachments) || body.attachments.some((a) => typeof a !== "string"))) return json({ error: "attachments must be a list of ids" }, 400);
				const text = (body.text as string | undefined) ?? "";
				const attachments = (body.attachments as string[] | undefined) ?? [];
				if (text.trim() === "" && attachments.length === 0) return json({ error: "text or attachments is required" }, 400);
				const client = source();
				if (!client.bindCardText) return json({ error: "this client has no paged cards" }, 501);
				await client.bindCardText(await resolve(client, ref), callId, qid, text, attachments.length ? attachments : undefined, undefined, key);
				return json({ accepted: true });
			} catch (err) {
				return failure(err);
			}
		},

		/** Skip a pending card: the console's side of `POST /v1/threads/:id/cards/:callId/skip`. */
		async skipCard(ref: ThreadRef, callId: string): Promise<Response> {
			try {
				const client = source();
				if (!client.skipCard) return json({ error: "this client has no cards" }, 501);
				return json(await client.skipCard(await resolve(client, ref), callId));
			} catch (err) {
				return failure(err);
			}
		},

		/** The thread's composer settings (tier, auto-ship) with the model each tier resolves to: `GET /v1/threads/:id/settings`. */
		async getSettings(ref: ThreadRef): Promise<Response> {
			try {
				const client = source();
				if (!client.getThreadSettings) return json({ error: "this client has no thread settings" }, 501);
				return json(await client.getThreadSettings(await resolve(client, ref)));
			} catch (err) {
				return failure(err);
			}
		},

		/** Change the thread's settings (body `{tier?, autoShip?}`, at least one): `PUT /v1/threads/:id/settings`. */
		async putSettings(ref: ThreadRef, req: Request): Promise<Response> {
			try {
				const client = source();
				if (!client.putThreadSettings) return json({ error: "this client has no thread settings" }, 501);
				const body = (await req.json().catch(() => null)) as { tier?: unknown; autoShip?: unknown } | null;
				const tierOk = body?.tier === undefined || body.tier === "main" || body.tier === "smart" || body.tier === "fast";
				const autoOk = body?.autoShip === undefined || typeof body.autoShip === "boolean";
				if (!body || !tierOk || !autoOk || (body.tier === undefined && body.autoShip === undefined)) {
					return json({ error: "body must be {tier?: main|smart|fast, autoShip?: boolean} with at least one" }, 400);
				}
				return json(await client.putThreadSettings(await resolve(client, ref), { ...(body.tier !== undefined ? { tier: body.tier as "main" | "smart" | "fast" } : {}), ...(body.autoShip !== undefined ? { autoShip: body.autoShip as boolean } : {}) }));
			} catch (err) {
				return failure(err);
			}
		},

		/** The thread's context size, window, thresholds and compaction history: `GET /v1/threads/:id/context`. */
		async getContext(ref: ThreadRef): Promise<Response> {
			try {
				const client = source();
				if (!client.getThreadContext) return json({ error: "this client has no context stats" }, 501);
				return json(await client.getThreadContext(await resolve(client, ref)));
			} catch (err) {
				return failure(err);
			}
		},

		/** Compact the thread now (body `{instructions?}`), allowed mid-turn: `POST /v1/threads/:id/compact`. */
		async compact(ref: ThreadRef, req: Request): Promise<Response> {
			try {
				const client = source();
				if (!client.compactThread) return json({ error: "this client cannot compact" }, 501);
				const body = (await req.json().catch(() => ({}))) as { instructions?: unknown } | null;
				if (!body || typeof body !== "object" || (body.instructions !== undefined && typeof body.instructions !== "string")) {
					return json({ error: "body must be {instructions?: string}" }, 400);
				}
				if (typeof body.instructions === "string" && body.instructions.length > 4000) return json({ error: "instructions are limited to 4000 characters" }, 400);
				await client.compactThread(await resolve(client, ref), body.instructions || undefined);
				return json({ accepted: true });
			} catch (err) {
				return failure(err);
			}
		},

		// --- feature progress: bind ---
		/** Bind the thread's conversation to a work item: the console's side of `POST /v1/threads/:id/bind` (body `{workItemId}`). */
		async bind(ref: ThreadRef, req: Request): Promise<Response> {
			try {
				const client = source();
				if (!client.bindThread) return json({ error: "this client cannot bind threads" }, 501);
				const body = (await req.json().catch(() => null)) as { workItemId?: unknown } | null;
				if (typeof body?.workItemId !== "string" || !body.workItemId) return json({ error: "body must be {workItemId}" }, 400);
				return json(await client.bindThread(await resolve(client, ref), body.workItemId));
			} catch (err) {
				return failure(err);
			}
		},
		// --- end feature progress ---

		/** A subagent thread's ledger (`{entries}`), oldest first. */
		async ledger(ref: ThreadRef): Promise<Response> {
			try {
				const client = source();
				if (!client.getLedger) return json({ error: "this wolf has no subagent ledger" }, 501);
				return json({ entries: await client.getLedger(await resolve(client, ref)) });
			} catch (err) {
				return failure(err);
			}
		},

		// ---- header git tree ----
		/** The live git status of a thread's workspace (the header popover). 404 when the thread has none; a client without git support has none. */
		async workspaceStatus(ref: ThreadRef): Promise<Response> {
			try {
				const client = source();
				if (!client.getWorkspaceStatus) return json({ error: "this wolf has no git workspaces" }, 404);
				return json(await client.getWorkspaceStatus(await resolve(client, ref)));
			} catch (err) {
				return failure(err);
			}
		},
		/** The branch graph (lanes + commits) of a thread's workspace, from read-only git. 404 when the thread has no git workspace. */
		async workspaceGraph(ref: ThreadRef): Promise<Response> {
			try {
				const client = source();
				const id = await resolve(client, ref);
				const ws = (await client.listThreads(ref.wolf)).find((t) => t.id === id)?.workspace;
				if (!ws) return json({ error: "this thread has no git workspace" }, 404);
				return json(await workspaceGraph(ws, ref.wolf));
			} catch (err) {
				return failure(err);
			}
		},
		// ---- /header git tree ----

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
			// A snapshot (stale cursor, or a mid-turn correction after a diverged final) is forwarded as a
			// `snapshot` frame the instant the client reports it; the adapter swaps its in-flight state for it.
			let out: ReadableStreamDefaultController<Uint8Array> | undefined;
			try {
				const client = source();
				const id = await resolve(client, ref);
				iterator = client.watch(id, {
					from: resumeCursor(req),
					onSnapshot: (snap) => {
						try {
							out?.enqueue(sseFrame(snap));
						} catch {
							// The stream is closed (client gone): throwing would make watch() reconnect.
						}
					},
				})[Symbol.asyncIterator]();
			} catch (err) {
				return failure(err);
			}
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					out = controller;
				},
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
