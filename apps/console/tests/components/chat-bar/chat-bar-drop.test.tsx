/** Images into the floating chat (work-wolfpack-WxHztAh): a drop on the bar (floating or docked) and a paste into its field attach; a docked bar takes a drop anywhere on the page. Real mount, stubbed fetch. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const mem = new Map<string, string>();
const localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage }),
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");
const { dataStore } = await import("../../../src/core/data-store.ts");
const { AttachedThreadProvider } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar } = await import("../../../components/chat-bar/chat-bar.tsx");
const { setDockSlot } = await import("../../../components/chat-bar/dock-slot.ts");
const { getDockedBarSink } = await import("../../../components/chat-bar/bar-drop.ts");
const { ATTACHED_KEY } = await import("../../../src/core/thread/chat-bar.ts");

const handlers = new Map<string, (d: string) => void>();
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const realFetch = globalThis.fetch;
let uploads: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST" && url.endsWith("/attachments")) {
		uploads.push(url);
		return Response.json({ id: "up-1", name: "a.png", mimeType: "image/png", size: 3 }, { status: 201 });
	}
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [{ id: "w/home", title: "home", kind: "home", status: "idle" }, { id: "w/a", title: "a", kind: "feature", status: "idle" }] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

let root: Root | null = null;
const flush = () => act(async () => void (await Promise.all([1, 2, 3, 4, 5, 6].map(() => new Promise((r) => setImmediate(r))))));
const until = async (cond: () => unknown, what: string) => {
	for (let i = 0; i < 100; i++) {
		if (cond()) return;
		await flush();
	}
	assert.fail(`timed out waiting for ${what}`);
};
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const qa = (s: string) => Array.from(document.querySelectorAll(s)) as HTMLElement[];
const props = (el: HTMLElement, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
const A = { wolf: "w", slug: "a", threadId: "w/a" };
const DockSlot = () => <div ref={setDockSlot} data-testid="thread-dock-slot" />;
async function mount(start: string, withDock = false) {
	mem.set(ATTACHED_KEY, JSON.stringify(A));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={start}>
				<ServerEventsProvider connect={fakeSource}>
					<AttachedThreadProvider>
						{withDock && <DockSlot />}
						<ChatBar />
					</AttachedThreadProvider>
				</ServerEventsProvider>
			</FakeNav>,
		);
	});
	await until(() => q('[data-testid="composer"] textarea'), "the composer");
	await flush();
}
const png = () => new File(["abc"], "a.png", { type: "image/png" });
const files = (f: File) => ({ types: ["Files"], files: [f] });
const chips = () => qa('[data-testid="attachment-chip"]');
const event = (extra: object = {}) => ({ preventDefault() {}, stopPropagation() {}, currentTarget: null, relatedTarget: null, ...extra });

afterEach(async () => {
	dataStore.clear();
	await act(async () => root?.unmount());
	setDockSlot(null);
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	uploads = [];
	handlers.clear();
});
after(() => void (globalThis.fetch = realFetch));

describe("images into the floating chat", () => {
	it("a file dragged over the bar lights it up and the drop attaches and uploads the image", async () => {
		await mount("/kb");
		const bar = q('[data-testid="chat-bar"]')!;
		assert.equal(bar.getAttribute("data-dropping"), null);
		await act(async () => void props(bar, "onDragOver")(event({ dataTransfer: files(png()) })));
		assert.equal(bar.getAttribute("data-dropping"), "true");
		await act(async () => void props(bar, "onDrop")(event({ dataTransfer: files(png()) })));
		assert.equal(bar.getAttribute("data-dropping"), null);
		await until(() => q('[data-testid="attachment-chip"][data-status="ready"]'), "the upload");
		assert.equal(chips().length, 1);
		assert.equal(uploads.length, 1);
	});

	it("a drag that carries no file leaves the bar alone", async () => {
		await mount("/kb");
		const bar = q('[data-testid="chat-bar"]')!;
		await act(async () => void props(bar, "onDragOver")(event({ dataTransfer: { types: ["text/plain"], files: [] } })));
		assert.equal(bar.getAttribute("data-dropping"), null);
	});

	it("pasting an image into the field attaches it", async () => {
		await mount("/kb");
		const field = q('[data-testid="composer"] textarea')!;
		await act(async () => void props(field, "onPaste")(event({ clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => png() }] } })));
		await until(() => q('[data-testid="attachment-chip"][data-status="ready"]'), "the upload");
		assert.equal(chips().length, 1);
	});

	it("a docked bar hands the page a sink, so a drop anywhere on the thread's page attaches to the bar; a floating bar hands none", async () => {
		await mount("/kb");
		assert.equal(getDockedBarSink(), null, "floating: the page keeps its own composer");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount("/wolf/w/thread/a", true);
		const sink = getDockedBarSink();
		assert.equal(typeof sink, "function");
		await act(async () => void sink!([png()]));
		await until(() => q('[data-testid="attachment-chip"][data-status="ready"]'), "the upload");
		assert.equal(chips().length, 1);
	});
});
