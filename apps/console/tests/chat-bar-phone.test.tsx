import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

(globalThis as Record<string, unknown>).self ??= globalThis;
const dom = parseHTML("<!doctype html><html><body></body></html>");
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
	KeyboardEvent: dom.window.KeyboardEvent,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

// linkedom does not track focus: record it so document.activeElement answers like a browser.
let focused: Element | null = null;
(dom.window.HTMLElement.prototype as any).focus = function () { focused = this; };
Object.defineProperty(dom.document, "activeElement", { get: () => focused, configurable: true });

// matchMedia stub: `phone` decides the md query; flipping it notifies listeners like a real resize.
let phone = true;
const mqls = new Set<() => void>();
(window as any).matchMedia = (query: string) => ({
	get matches() { return /min-width: 768px/.test(query) ? !phone : false; },
	addEventListener: (_: string, cb: () => void) => void mqls.add(cb),
	removeEventListener: (_: string, cb: () => void) => void mqls.delete(cb),
});
const resize = (toPhone: boolean) => act(async () => { phone = toPhone; mqls.forEach((cb) => cb()); });

const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { FakeNav } = await import("./helpers/fake-nav.tsx");
const { AttachedThreadProvider } = await import("../components/attached-thread.tsx");
const { ChatBar } = await import("../components/chat-bar.tsx");
const { ATTACHED_KEY, BAR_EXTRAS } = await import("../src/core/chat-bar.ts");
// The extras (cards, peek, badge, switcher) are off in the shipped floating chat; this file covers their kept code, so it switches them on.
Object.assign(BAR_EXTRAS, { cards: true, peek: true, badge: true, switcher: true });

type Call = { url: string; body?: any };
let calls: Call[] = [];
/** Per thread slug: what GET thread returns. */
let bodies: Record<string, { messages: any[]; pendingCards: any[] }> = {};
let threadStatus: Record<string, string> = {};
let extraThreads: any[] = [];
let failGet = new Set<string>();
let needsYou: { wolf: string; threadId: string; raisedAt: string }[] | null = null; // null = the route fails
const handlers = new Map<string, (d: string) => void>();
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const emit = (n: string, d: object) => act(async () => void handlers.get(n)?.(JSON.stringify(d)));
const realFetch = globalThis.fetch;
const th = (id: string, extra: object = {}) => ({ id, title: id, kind: "feature", status: threadStatus[id] ?? "idle", ...extra });
const body = (slug: string) => bodies[slug] ?? { messages: [], pendingCards: [] };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST") {
		calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		const slug = /\/threads\/([^/]+)\//.exec(url)![1]!;
		if (url.endsWith("/submit")) body(slug).pendingCards = []; // the wolf closes every pending card as superseded
		const m = /\/cards\/([^/]+)\//.exec(url);
		if (m) body(slug).pendingCards = body(slug).pendingCards.filter((p) => p.callId !== m[1]);
		return new Response(JSON.stringify({ disposition: "started" }), { status: 200 });
	}
	if (url === "/api/needs-you") return needsYou ? Response.json({ items: needsYou }) : new Response("{}", { status: 500 });
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [th("w/home", { kind: "home" }), th("w/a"), th("w/b"), th("w/c"), ...extraThreads] });
	const g = /^\/api\/wolves\/w\/threads\/([^/?]+)\?/.exec(url);
	if (g) {
		const slug = g[1]!;
		if (failGet.has(slug)) return new Response("{}", { status: 500 });
		const snapshot = JSON.parse(JSON.stringify(body(slug)));
		return Response.json(snapshot);
	}
	return new Response("{}", { status: 503 });
}) as typeof fetch;

let root: Root | null = null;
/** Let stubbed fetches, promise chains and React effects settle (a few macrotask turns; no wall-clock sleeps). */
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
let startPath = "/kb";
async function mount(stored: object | null = A, extra?: React.ReactNode, expectBar = true) {
	if (stored) mem.set(ATTACHED_KEY, JSON.stringify(stored));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={startPath}>
				<ServerEventsProvider connect={fakeSource}>
					<AttachedThreadProvider>
						<ChatBar />
						{extra}
					</AttachedThreadProvider>
				</ServerEventsProvider>
			</FakeNav>,
		);
	});
	if (expectBar) await until(() => q('[data-testid="composer"] textarea'), "the composer");
	await flush();
}
const ta = () => q('[data-testid="composer"] textarea') as HTMLTextAreaElement;
const props = (el: HTMLElement, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
const type = (v: string) =>
	act(async () => {
		const el = ta();
		el.value = v;
		props(el, "onChange")({ target: el, currentTarget: el });
	});
const click = (el: HTMLElement | null) => act(async () => void props(el!, "onClick")({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} }));
const submit = () => act(async () => void ta().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
const byText = (sel: string, t: string) => qa(sel).find((b) => b.textContent?.trim() === t) ?? null;
const bar = () => q('[data-testid="chat-bar"]')!;
const touch = (el: HTMLElement, name: "onTouchStart" | "onTouchEnd" | "onTouchCancel", y: number, x = 0) =>
	act(async () => void props(el, name)({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] }));
const esc = () =>
	act(async () => {
		const ev = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
		Object.assign(ev, { key: "Escape" });
		document.dispatchEvent(ev);
	});
const reserve = () => document.documentElement.style.getPropertyValue("--chat-bar-reserve");

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	calls = [];
	bodies = {};
	handlers.clear();
	phone = true;
	startPath = "/kb";
	document.body.style.overflow = "";
	document.documentElement.style.removeProperty("--chat-bar-reserve");
	delete (window as any).visualViewport;
	focused = null;
});
after(() => void (globalThis.fetch = realFetch));

const A = { wolf: "w", slug: "a", threadId: "w/a" };
const colors = { fields: [{ id: "c", kind: "single", label: "Which color?", options: [{ label: "Red", value: "red" }], allowOther: false }] };
const raise = (slug: string, ...ids: string[]) => void (bodies[slug] = { messages: [], pendingCards: ids.map((callId) => ({ callId, threadId: "w/a", card: { tool: "ask_user_question", ...colors }, raisedAt: "2026-01-01T00:00:00Z" })) });

describe("ChatBar on a phone", () => {
	it("is a full-width dock below md and the floating pill from md up, switching live", async () => {
		await mount();
		assert.equal(bar().getAttribute("data-layout"), "dock");
		assert.match(bar().className, /inset-x-0/);
		await resize(false);
		assert.equal(bar().getAttribute("data-layout"), null);
		assert.match(bar().className, /w-\[min\(42rem/);
		assert.doesNotMatch(bar().className, /inset-x-0/);
		await resize(true);
		assert.equal(bar().getAttribute("data-layout"), "dock");
	});

	it("keeps every dock control at 44px or more and respects the safe area", async () => {
		await mount();
		for (const id of ["chat-bar-chip", "bar-sheet-open", "chat-bar-minimize"]) assert.match(q(`[data-testid="${id}"]`)!.className, /min-h-11/, id);
		assert.match(bar().getAttribute("style")!, /env\(safe-area-inset-bottom\)/);
		await click(q('[data-testid="bar-sheet-open"]'));
		assert.match(q('[data-testid="bar-sheet-close"]')!.className, /min-h-11/);
	});

	it("a pending card shows as a strip; tapping it opens the sheet with the card above the composer", async () => {
		raise("a", "c1", "c2");
		await mount();
		assert.equal(q('[data-testid="bar-card"]'), null);
		assert.equal(q('[data-testid="bar-strip"]')!.textContent, "2 cards waiting");
		await click(q('[data-testid="bar-strip"]'));
		assert.equal(bar().getAttribute("data-state"), "sheet");
		assert.match(q('[data-testid="bar-card"]')!.textContent!, /Which color\?/);
		assert.equal(q('[data-testid="bar-card-counter"]')!.textContent, "1 of 2");
		const order = qa('[data-testid="bar-card"], [data-testid="composer"]').map((e) => e.getAttribute("data-testid"));
		assert.deepEqual(order, ["bar-card", "composer"]);
	});

	it("the chevron closes the sheet and the draft survives", async () => {
		await mount();
		await type("half a thought");
		await click(q('[data-testid="bar-sheet-open"]'));
		assert.equal(bar().getAttribute("data-state"), "sheet");
		assert.equal(ta().value, "half a thought");
		await click(q('[data-testid="bar-sheet-close"]'));
		assert.equal(bar().getAttribute("data-state"), "open");
		assert.equal(ta().value, "half a thought");
	});

	it("a swipe down on the handle closes the sheet; a short one does not", async () => {
		await mount();
		await type("keep me");
		await click(q('[data-testid="bar-sheet-open"]'));
		const handle = () => q('[data-testid="bar-sheet-handle"]')!;
		await touch(handle(), "onTouchStart", 100);
		await touch(handle(), "onTouchEnd", 130);
		assert.equal(bar().getAttribute("data-state"), "sheet");
		await touch(handle(), "onTouchStart", 100);
		await touch(handle(), "onTouchEnd", 220, 400); // mostly horizontal
		assert.equal(bar().getAttribute("data-state"), "sheet");
		await touch(handle(), "onTouchStart", 100);
		await touch(handle(), "onTouchCancel", 100);
		await touch(handle(), "onTouchEnd", 220);
		assert.equal(bar().getAttribute("data-state"), "sheet");
		await touch(handle(), "onTouchStart", 100);
		await touch(handle(), "onTouchEnd", 220);
		assert.equal(bar().getAttribute("data-state"), "open");
		assert.equal(ta().value, "keep me");
	});

	it("the switcher is a full-screen sheet on phone and a popover on desktop", async () => {
		await mount();
		await click(q('[data-testid="chat-bar-chip"]'));
		assert.equal(q('[data-testid="chat-bar-switcher"]')!.getAttribute("data-layout"), "sheet");
		assert.match(q('[data-testid="switcher-entry"]')!.className, /min-h-11/);
		await click(q('[data-testid="switcher-close"]'));
		assert.equal(q('[data-testid="chat-bar-switcher"]'), null);
		await resize(false);
		await click(q('[data-testid="chat-bar-chip"]'));
		assert.equal(q('[data-testid="chat-bar-switcher"]')!.getAttribute("data-layout"), "popover");
		assert.equal(q('[data-testid="switcher-close"]'), null);
	});

	it("desktop keeps its cards inline with no strip or sheet controls", async () => {
		phone = false;
		raise("a", "c1");
		await mount();
		assert.match(q('[data-testid="bar-card"]')!.textContent!, /Which color\?/);
		assert.equal(q('[data-testid="bar-strip"]'), null);
		assert.equal(q('[data-testid="bar-sheet-open"]'), null);
	});

	it("the sheet is a modal: dialog semantics, focus in and back, no page scroll, Esc closes it before the work reader", async () => {
		const { WorkReaderPanel } = await import("../components/work-reader.tsx");
		let readerClosed = 0;
		await mount(A, <WorkReaderPanel id="f1" onClose={() => void readerClosed++} />);
		const opener = q('[data-testid="bar-sheet-open"]')!;
		await click(opener);
		assert.equal(bar().getAttribute("role"), "dialog");
		assert.equal(bar().getAttribute("aria-modal"), "true");
		assert.ok(bar().getAttribute("aria-label"));
		assert.equal(document.activeElement?.getAttribute("data-testid"), "bar-sheet-close");
		assert.equal(document.body.style.overflow, "hidden");
		assert.equal(q('[data-testid="work-reader"]')?.getAttribute("data-work"), "f1");
		await esc();
		assert.equal(bar().getAttribute("data-state"), "open");
		assert.equal(readerClosed, 0);
		assert.equal(document.body.style.overflow, "");
		assert.equal(document.activeElement?.getAttribute("data-testid"), "bar-sheet-open");
	});

	it("auto-closes a sheet opened for a card once it is answered, but not while typing", async () => {
		for (const mode of ["idle", "draft", "focused"] as const) {
			raise("a", "c1");
			await mount();
			await click(q('[data-testid="bar-strip"]'));
			if (mode === "draft") await type("still writing");
			if (mode === "focused") ta().focus();
			await click(byText("button", "Red"));
			await click(q('[data-testid="card-submit"]'));
			await until(() => !q('[data-testid="bar-card"]'), "the card to go");
			await flush();
			assert.equal(bar().getAttribute("data-state"), mode === "idle" ? "open" : "sheet", mode);
			await act(async () => root?.unmount());
			root = null;
			document.body.innerHTML = "";
			mem.clear();
			bodies = {};
		}
	});

	it("lifts the dock above the on-screen keyboard (visualViewport) and drops the safe-area padding", async () => {
		const listeners: Record<string, () => void> = {};
		(window as any).innerHeight = 800;
		(window as any).visualViewport = { height: 500, offsetTop: 0, addEventListener: (n: string, cb: () => void) => void (listeners[n] = cb), removeEventListener() {} };
		await mount();
		assert.match(bar().getAttribute("style")!, /bottom:\s*300px/);
		assert.doesNotMatch(bar().getAttribute("style")!, /env\(safe-area/);
		(window as any).visualViewport.height = 800;
		await act(async () => listeners.resize?.());
		assert.match(bar().getAttribute("style")!, /bottom:\s*0(px)?\b/);
		assert.match(bar().getAttribute("style")!, /env\(safe-area-inset-bottom\)/);
	});

	it("reserves room for the dock on phone pages, also when minimized, and clears it when the dock goes", async () => {
		(HTMLElement.prototype as any).getBoundingClientRect = () => ({ height: 90 });
		await mount();
		assert.equal(reserve(), "90px");
		await click(q('[data-testid="chat-bar-minimize"]'));
		assert.equal(bar().getAttribute("data-state"), "minimized");
		assert.equal(reserve(), "90px");
		assert.ok(q('[data-testid="chat-bar-expand"]')!.className.includes("min-h-11"));
		await resize(false); // desktop pill, minimized: no reserve
		assert.equal(reserve(), "");
	});

	it("hides the dock on the attached thread's own page and on other thread pages (their composer is at the bottom), but not the desktop pill", async () => {
		startPath = "/wolf/w/thread/a";
		await mount(A, undefined, false);
		assert.equal(q('[data-testid="chat-bar"]'), null, "own page");
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		startPath = "/wolf/w/thread/b";
		await mount(A, undefined, false);
		assert.equal(q('[data-testid="chat-bar"]'), null, "another thread page");
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		phone = false;
		await mount();
		assert.equal(bar().getAttribute("data-state"), "open", "desktop pill on another thread page");
	});

	it("shows no dock and reserves nothing until something is popped out", async () => {
		(HTMLElement.prototype as any).getBoundingClientRect = () => ({ height: 90 });
		await mount(null, undefined, false);
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(reserve(), "");
	});

	it("the Dock button clears the popped-out thread and keeps its draft", async () => {
		await mount();
		await type("phone draft");
		await click(q('[data-testid="chat-bar-dock"]'));
		await flush();
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(reserve(), "");
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "phone draft");
	});

	it("keeps the draft when the viewport crosses 768px and the composer remounts", async () => {
		await mount();
		await type("across the breakpoint");
		await resize(false);
		await flush();
		assert.equal(bar().getAttribute("data-layout"), null);
		assert.equal(ta().value, "across the breakpoint");
		await resize(true);
		await flush();
		assert.equal(ta().value, "across the breakpoint");
	});
});
