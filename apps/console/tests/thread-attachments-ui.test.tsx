/**
 * Image drop / picker / history thumbnails: the pure extraction + precheck,
 * the history decoration (path stripping, thumbnails after a reload), the
 * optimistic bubble, steer with attachments, the attachment GET relay, and the
 * ThreadChat DOM (drop and picker upload, error chips).
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});

const { ATTACHMENT_MAX_BYTES, FIXTURE_THREAD, MockConsoleClient } = await import("@wolfpack/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { AttachmentChips, Composer } = await import("../components/composer.tsx");
const { SessionModel } = await import("../components/session-core.ts");
const { threadTransport } = await import("../components/thread-transport.ts");
const { threadMessagesToNative } = await import("../src/core/index.ts");
const { createThreadApi } = await import("../src/server/thread-api.ts");
const { threadFetch } = await import("./helpers/thread-fetch.ts");
const A = await import("../components/attachments.ts");

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const png = (name = "a.png") => new File([PNG], name, { type: "image/png" });
const ID = "11111111-2222-4333-8444-555555555555";
const history = (text: string, attachments = [{ id: ID, name: `${ID}.png`, mimeType: "image/png", size: 11 }]) => [
	{ id: "entry-1", role: "user" as const, text, at: "2026-10-01T00:00:00.000Z", attachments },
	{ id: "entry-2", role: "assistant" as const, text: "nice", at: "2026-10-01T00:00:01.000Z" },
];
const PATH_LINE = `[Attached image: /den/attachments/w/home/${ID}.png]`;

describe("drop / picker extraction", () => {
	it("recognises a file drag and lists every dropped file (non-images get an error chip later)", () => {
		const f = png();
		const pdf = new File(["x"], "a.pdf", { type: "application/pdf" });
		assert.equal(A.dragHasFiles({ types: ["text/plain", "Files"] }), true);
		assert.equal(A.dragHasFiles({ types: ["text/plain"] }), false);
		assert.equal(A.dragHasFiles(null), false);
		assert.deepEqual(A.droppedFiles({ files: [f, pdf] }), [f, pdf]);
		assert.deepEqual(A.droppedFiles(null), []);
	});

	it("the composer renders a picker input limited to the allowed image types, only when wired", () => {
		const props = { busy: false, value: "", onChange() {}, onSend() {}, onStop() {}, canSend: false };
		const on = renderToStaticMarkup(<Composer {...props} onPickFiles={() => {}} />);
		assert.match(on, /data-testid="attachment-picker"/);
		assert.match(on, /accept="image\/png,image\/jpeg,image\/gif,image\/webp"/);
		assert.match(on, /aria-label="Attach images"/);
		assert.doesNotMatch(renderToStaticMarkup(<Composer {...props} />), /attachment-picker/);
	});
});

describe("client-side precheck", () => {
	it("accepts allowed images and refuses wrong type, empty and oversize files with a reason", () => {
		assert.equal(A.precheckFile({ type: "image/png", size: 10 }), undefined);
		assert.equal(A.precheckFile({ type: "image/webp", size: ATTACHMENT_MAX_BYTES }), undefined);
		assert.match(A.precheckFile({ type: "application/pdf", size: 10 })!, /Unsupported type application\/pdf: images only/);
		assert.match(A.precheckFile({ type: "", size: 10 })!, /Unsupported type \(unknown\)/);
		assert.match(A.precheckFile({ type: "image/png", size: 0 })!, /empty/);
		assert.match(A.precheckFile({ type: "image/png", size: ATTACHMENT_MAX_BYTES + 1 })!, /Too large .*limit 5 MB/);
	});

	it("chipFor: ok files become uploading chips, refused ones an error chip with nothing to upload", () => {
		assert.deepEqual(A.chipFor(png("ok.png"), "k1"), { chip: { key: "k1", name: "ok.png", status: "uploading", mimeType: "image/png", size: PNG.length }, upload: true });
		const bad = A.chipFor(new File(["x"], "a.txt", { type: "text/plain" }), "k2");
		assert.equal(bad.upload, false);
		assert.equal(bad.chip.status, "error");
		const html = renderToStaticMarkup(<AttachmentChips items={[bad.chip]} onRemove={() => {}} />);
		assert.match(html, /a\.txt — Unsupported type text\/plain/);
	});
});

describe("history: path stripping and thumbnails", () => {
	it("strips only the attachment path lines; the model-facing text is untouched", () => {
		assert.equal(A.stripAttachmentLines(`what is this?\n\n${PATH_LINE}`), "what is this?");
		assert.equal(A.stripAttachmentLines(PATH_LINE), "");
		assert.equal(A.stripAttachmentLines(`a\n${PATH_LINE}\n${PATH_LINE}`), "a");
		assert.equal(A.stripAttachmentLines("see [Attached image: x] inline"), "see [Attached image: x] inline");
		const h = history(`hi\n\n${PATH_LINE}`);
		A.withHistoryAttachments(threadMessagesToNative(h), h);
		assert.equal(h[0]!.text, `hi\n\n${PATH_LINE}`);
	});

	it("decorates only user messages that carry attachments, matched by id", () => {
		const h = [...history(`hi\n\n${PATH_LINE}`), { id: "entry-3", role: "user" as const, text: `typed ${PATH_LINE}`, at: "2026-10-01T00:00:02.000Z" }];
		const out = A.withHistoryAttachments(threadMessagesToNative(h), h) as unknown as { id: string; content: unknown; attachments?: unknown[] }[];
		assert.equal(out[0]!.content, "hi");
		assert.equal(out[0]!.attachments?.length, 1);
		assert.equal(out[1]!.attachments, undefined);
		assert.equal(out[2]!.content, `typed ${PATH_LINE}`); // no attachments: left alone
		assert.equal(out[2]!.attachments, undefined);
	});
});

let root: Root | null = null;
const realFetch = globalThis.fetch;
const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
let uploads: { url: string; type: string | null; size: number }[] = [];
globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
	if (String(url).endsWith("/attachments") && init?.method === "POST") {
		const body = init.body as Blob;
		uploads.push({ url: String(url), type: (init.headers as Record<string, string>)["Content-Type"] ?? null, size: body.size });
		return Response.json({ id: `up-${uploads.length}`, name: "dropped.png", mimeType: "image/png", size: body.size }, { status: 201 });
	}
	return new Response("{}", { status: 404 });
}) as typeof fetch;

async function mount(messages: unknown[]) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<MemoryEventsProvider connect={inertSource}>
						<ThreadChat wolf="w" slug="s" threadId="t1" title="T" initialMessages={messages as never} />
					</MemoryEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
	});
}

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	uploads = [];
});

const fire = (el: Element, type: string, extra: Record<string, unknown> = {}) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), extra));
	});
const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));

describe("ThreadChat", () => {
	it("after a reload the user bubble shows the thumbnail, not the path line", async () => {
		const h = history(`look\n\n${PATH_LINE}`);
		await mount(A.withHistoryAttachments(threadMessagesToNative(h), h));
		const bubble = document.querySelector('[data-testid="user-message"]')!;
		assert.equal(bubble.querySelector(".lh-prose")!.textContent, "look");
		assert.doesNotMatch(bubble.textContent ?? "", /Attached image/);
		const img = bubble.querySelector('[data-testid="attachment-thumb"]')!;
		assert.equal(img.getAttribute("src"), `/api/wolves/w/threads/s/attachments/${ID}`);
	});

	it("an image-only history message renders the thumbnail with an empty text", async () => {
		const h = history(PATH_LINE);
		await mount(A.withHistoryAttachments(threadMessagesToNative(h), h));
		const bubble = document.querySelector('[data-testid="user-message"]')!;
		assert.equal(bubble.querySelector(".lh-prose")!.textContent, "");
		assert.equal(bubble.querySelectorAll('[data-testid="attachment-thumb"]').length, 1);
	});

	it("dropping image files uploads them; a non-image gets an error chip and no upload", async () => {
		await mount([]);
		const chat = document.querySelector('[data-testid="thread-chat"]')!;
		const files = [png("dropped.png"), new File(["x"], "notes.txt", { type: "text/plain" })];
		await fire(chat, "dragover", { dataTransfer: { types: ["Files"], files } });
		assert.equal(chat.getAttribute("data-dragging"), "true");
		const drop = await (async () => {
			const ev = Object.assign(new dom.window.Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: { types: ["Files"], files } });
			await act(async () => void chat.dispatchEvent(ev));
			return ev;
		})();
		assert.equal(drop.defaultPrevented, true);
		await flush();
		assert.equal(uploads.length, 1);
		assert.deepEqual([uploads[0]!.type, uploads[0]!.size], ["image/png", PNG.length]);
		const chips = [...document.querySelectorAll('[data-testid="attachment-chip"]')];
		assert.deepEqual(chips.map((c) => c.getAttribute("data-status")), ["ready", "error"]);
		assert.match(chips[1]!.textContent ?? "", /notes\.txt — Unsupported type text\/plain/);
		assert.equal(chat.getAttribute("data-dragging"), null);
	});

	it("a drag with no files is left to the browser", async () => {
		await mount([]);
		const chat = document.querySelector('[data-testid="thread-chat"]')!;
		const ev = Object.assign(new dom.window.Event("dragover", { bubbles: true, cancelable: true }), { dataTransfer: { types: ["text/plain"], files: [] } });
		await act(async () => void chat.dispatchEvent(ev));
		assert.equal(ev.defaultPrevented, false);
	});

	it("choosing files with the picker uploads them", async () => {
		await mount([]);
		const input = document.querySelector('[data-testid="attachment-picker"]') as HTMLInputElement;
		await fire(input, "change", { target: Object.assign(input, { files: [png("picked.png")], value: "" }) });
		await flush();
		assert.equal(uploads.length, 1);
		assert.equal(document.querySelectorAll('[data-testid="attachment-chip"][data-status="ready"]').length, 1);
	});
});

describe("optimistic bubble and steer", () => {
	const upload = async (client: InstanceType<typeof MockConsoleClient>) => {
		const f = threadFetch(client);
		return A.uploadFile(threadTransport("1uk4", "home").uploadUrl!, png("shot.png"), f);
	};

	it("an image-only send shows the thumbnail at once (empty text, attachment part)", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const att = await upload(client);
		let optimistic: ReturnType<InstanceType<typeof SessionModel>["getState"]>["messages"] | undefined;
		const fetchFn = threadFetch(client);
		const model = new SessionModel({
			chatId: FIXTURE_THREAD.id,
			initialMessages: [],
			transport: threadTransport("1uk4", "home"),
			fetch: (async (url: RequestInfo | URL, init?: RequestInit) => {
				optimistic ??= model.getState().messages;
				return fetchFn(url, init);
			}) as typeof fetch,
		});
		await model.send({ type: "text", text: "", attachments: [att] });
		const user = optimistic!.find((m) => m.role === "user")!;
		const part = user.parts.find((p) => p.type === "data-attachments")!;
		assert.deepEqual(part.data, [att]);
		assert.equal(user.parts.find((p) => p.type === "text")?.text, "");
		assert.deepEqual(client.submits.at(-1)!.attachments, [{ id: att.id }]); // the wire carries refs only
	});

	it("(c) a steer carries the attachments in the submit body and echoes them", async () => {
		const calls: string[] = [];
		const model = new SessionModel({
			chatId: "c",
			initialMessages: [],
			transport: threadTransport("w", "s"),
			fetch: (async (_u: RequestInfo | URL, init?: RequestInit) => (calls.push(String(init?.body)), new Response("{}"))) as typeof fetch,
		});
		await model.steer("", [{ id: "a1", name: "x.png", mimeType: "image/png", size: 3 }]); // image-only steer
		assert.deepEqual(JSON.parse(calls[0]!), { input: "", whenBusy: "steer", attachments: [{ id: "a1" }] });
		const echo = model.getState().messages.find((m) => m.role === "user")!;
		assert.equal(echo.parts.some((p) => p.type === "data-attachments"), true);
		await model.steer(""); // nothing at all: not sent
		assert.equal(calls.length, 1);
	});
});

describe("attachment GET relay", () => {
	const ref = { wolf: "1uk4", slug: "home" };
	it("serves the stored bytes as an image with nosniff and a sandbox CSP", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const att = await client.uploadAttachment(FIXTURE_THREAD.id, PNG, { mimeType: "image/png" });
		const res = await threadFetch(client)(`/api/wolves/1uk4/threads/home/attachments/${att.id}`);
		assert.equal(res.status, 200);
		assert.equal(res.headers.get("content-type"), "image/png");
		assert.equal(res.headers.get("x-content-type-options"), "nosniff");
		assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
		assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);
	});

	it("404s malformed, traversal, unknown ids and an unknown thread", async () => {
		const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));
		for (const id of ["../etc/passwd", "..", "a/b", "a.b", "a%2Fb", "", "x".repeat(65), "att-99"]) {
			assert.equal((await api.attachment(ref, id)).status, 404, JSON.stringify(id));
		}
		assert.equal((await api.attachment({ wolf: "1uk4", slug: "nope" }, "att-1")).status, 404);
	});

	it("never serves a non-image mime from the console origin", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		client.getAttachment = async () => ({ bytes: new TextEncoder().encode("<script>"), mimeType: "text/html" });
		assert.equal((await createThreadApi(() => client).attachment(ref, "att-1")).status, 404);
	});
});
