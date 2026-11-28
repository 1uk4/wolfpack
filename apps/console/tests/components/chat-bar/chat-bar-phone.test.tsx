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

// matchMedia stub: `phone` decides the shared PHONE_QUERY (answered through isPhoneViewport, the same rule); flipping it notifies listeners like a real resize.
let phone = true;
const mqls = new Set<() => void>();
(window as any).matchMedia = (query: string) => ({
	get matches() { return query === PHONE_QUERY ? isPhoneViewport(phone ? 390 : 1280, 800, false) : false; },
	addEventListener: (_: string, cb: () => void) => void mqls.add(cb),
	removeEventListener: (_: string, cb: () => void) => void mqls.delete(cb),
});
const resize = (toPhone: boolean) => act(async () => { phone = toPhone; mqls.forEach((cb) => cb()); });

const { PHONE_QUERY, isPhoneViewport } = await import("../../../src/core/thread/phone-viewport.ts");
const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");
const { AttachedThreadProvider } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar } = await import("../../../components/chat-bar/chat-bar.tsx");
const { ATTACHED_KEY, BAR_EXTRAS } = await import("../../../src/core/thread/chat-bar.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");
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
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w", ...(wolfColor ? { color: wolfColor } : {}) }, ...otherWolves.map((name) => ({ name }))] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [...(noHome ? [] : [th("w/home", { kind: "home" })]), th("w/a"), th("w/b"), th("w/c"), ...extraThreads] });
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
let wolfColor: string | undefined; // the roster's colour for wolf "w"
let otherWolves: string[] = []; // more wolves on the roster (their den avatars)
let noHome = false; // the wolf has no home thread: nothing to auto-attach
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
const openFull = async () => {
	await click(q('[data-testid="chat-bar-settings"]'));
	await click(q('[data-testid="bar-sheet-open"]'));
};
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
	threadStatus = {};
	dataStore.clear(); // the thread list goes through the client store: the next test must not read this one's list (production keeps one store per session)
	document.body.innerHTML = "";
	mem.clear();
	calls = [];
	bodies = {};
	handlers.clear();
	phone = true;
	startPath = "/kb";
	noHome = false;
	wolfColor = undefined;
	otherWolves = [];
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
	it("tints a wolf with no config colour by the colour the den strip shows for it", async () => {
		await mount();
		assert.equal(bar().getAttribute("data-wolf-color"), "red"); // the automatic colour of "w/home"
	});

	it("carries the attached wolf's colour onto the bar root", async () => {
		wolfColor = "blue";
		await mount();
		assert.equal(bar().getAttribute("data-wolf-color"), "blue");
		assert.match(bar().getAttribute("style") ?? "", /--wolf-accent:\s*light-dark\(#1f6fc0, #6cb2f2\)/);
	});

	it("carries the wolf's colour onto the floating desktop bar root, and its border takes the wolf accent", async () => {
		(window as any).innerWidth = 1440;
		wolfColor = "blue";
		await resize(false);
		await mount();
		assert.equal(bar().getAttribute("data-layout"), null); // the floating pill, not the phone dock
		assert.equal(bar().getAttribute("data-wolf-color"), "blue");
		assert.match(bar().getAttribute("style") ?? "", /--wolf-accent:\s*light-dark\(#1f6fc0, #6cb2f2\)/);
		assert.match(bar().querySelector<HTMLElement>("[data-testid=composer]")!.closest(".rounded-2xl")!.getAttribute("style") ?? "", /border-color:\s*var\(--wolf-accent\)/);
	});

	it("is a full-width dock below md and the floating pill from md up, switching live", async () => {
		(window as any).innerWidth = 1440;
		await mount();
		assert.equal(bar().getAttribute("data-layout"), "dock");
		assert.match(bar().className, /inset-x-0/);
		await resize(false);
		assert.equal(bar().getAttribute("data-layout"), null);
		// No column measured (linkedom has no layout): the bar centres on the window, capped at 900px.
		assert.match(bar().getAttribute("style")!, /width:\s*900px/);
		assert.doesNotMatch(bar().className, /inset-x-0/);
		await resize(true);
		assert.equal(bar().getAttribute("data-layout"), "dock");
	});

	it("desktop: centres on the registered page column, and a narrow column moves gear, shrink and swap into the ... menu", async () => {
		phone = false;
		(window as any).innerWidth = 1440;
		await mount();
		const column = (left: number, width: number) => {
			const el = document.createElement("div");
			(el as any).getBoundingClientRect = () => ({ left, width, top: 0, height: 100 });
			return el;
		};
		const frame = () => act(async () => void (await new Promise((r) => setTimeout(r, 20)))); // the store measures once per animation frame (a timer here)
		const { registerColumn } = await import("../../../components/chat-bar/column-store.ts");
		await act(async () => registerColumn(column(100, 600)));
		await frame();
		assert.match(bar().getAttribute("style")!, /left:\s*400px/);
		assert.match(bar().getAttribute("style")!, /width:\s*568px/);
		assert.ok(q('[data-testid="chat-bar-settings"]'), "wide column: the gear is in the header");
		assert.equal(q('[data-testid="chat-bar-overflow"]'), null);
		await act(async () => registerColumn(column(100, 400)));
		await frame();
		assert.match(bar().getAttribute("style")!, /width:\s*420px/);
		assert.equal(q('[data-testid="chat-bar-settings"]'), null, "narrow column: the gear leaves the header");
		// The thread title truncates with an ellipsis and the chip may shrink, so nothing overflows the bar.
		const chip = q('[data-testid="chat-bar-chip"]')!;
		assert.match(chip.className, /\bmin-w-0\b/);
		assert.match(chip.querySelector("span.truncate")!.className, /\btruncate\b/);
		await click(q('[data-testid="chat-bar-overflow"]'));
		assert.ok(q('[data-testid="chat-bar-overflow-menu"] [data-testid="chat-bar-settings"]'), "and waits in the menu");
		await act(async () => registerColumn(null));
	});

	it("the phone dock lists the thread's frame badges above the input, with the chat icon while viz mode is on", async () => {
		const { setVizActive } = await import("../../../components/viewer/viz-mode.ts");
		mem.set("wolfpack:frames:w/a", JSON.stringify([{ objectId: "f1", path: "a.html", title: "Plan", rev: 1 }]));
		setVizActive({ wolf: "w", threadId: "w/a" });
		try {
			await mount();
			const row = bar().querySelector('[data-testid="frame-badges"]') as HTMLElement;
			assert.ok(row, "the dock has the badge row");
			assert.equal(bar().getAttribute("data-layout"), "dock");
			assert.deepEqual([...row.querySelectorAll('[data-testid="frame-badge"]')].map((b) => b.textContent?.trim()), ["Plan"]);
			assert.ok(row.querySelector('[data-testid="frame-badges-chat"]'), "the chat icon leaves viz mode");
			assert.ok(row.compareDocumentPosition(ta()) & 4, "the row comes before the input");
		} finally {
			setVizActive(null);
		}
	});

	it("keeps every dock control at 44px or more and respects the safe area", async () => {
		await mount();
		for (const id of ["chat-bar-chip", "chat-bar-settings", "chat-bar-minimize"]) assert.match(q(`[data-testid="${id}"]`)!.className, /min-h-11/, id);
		assert.match(bar().getAttribute("style")!, /env\(safe-area-inset-bottom\)/);
		await openFull();
		assert.match(q('[data-testid="bar-sheet-close"]')!.className, /min-h-11/);
	});

	it("puts attach before the input and send after it in the wide panel; the dock is voice-first with a large mic and add-image beside it", async () => {
		const order = () => qa('[data-testid="composer"] button[aria-label="Attach images"], [data-testid="composer"] textarea, [data-testid="composer"] button[type="submit"]').map((e) => (e.tagName === "TEXTAREA" ? "input" : e.getAttribute("aria-label") === "Attach images" ? "attach" : "send"));
		await mount();
		const form = () => q('[data-testid="composer"]')!;
		assert.equal(form().getAttribute("data-field"), "voice");
		const main = q('[data-testid="voice-main"]')!;
		assert.equal(main.getAttribute("aria-label"), "Start dictation");
		assert.match(q('[data-testid="composer"] button[aria-label="Attach images"]')!.className, /size-11/); // 44px
		assert.deepEqual(order().filter((x) => x !== "input"), ["attach", "send"], "add-image sits beside the mic");
		// The text field is one tap away: the compact field in the same row.
		await click(q('[data-testid="voice-field"]'));
		assert.equal(form().getAttribute("data-field"), "text");
		await type("hello");
		assert.equal(q('[data-testid="voice-main"]')!.getAttribute("aria-label"), "Send", "with text the big button sends");
		await resize(false);
		assert.equal(q('[data-testid="voice-main"]'), null, "the wide panel keeps its classic composer");
		assert.deepEqual(order(), ["attach", "input", "send"]);
	});

	it("the phone dock is one composer row (attach, field, mic) with the wolf avatars on the header line and the name shown once", async () => {
		await mount();
		const row = q('[data-testid="composer"]')!;
		assert.doesNotMatch(row.className, /flex-wrap/, "one row, never wrapped");
		assert.equal(row.querySelector('[data-testid="voice-field"]')!.className.includes("basis-full"), false, "the field shares the row");
		assert.equal(q('[data-testid="voice-keyboard"]'), null, "no keyboard button: the field itself opens the input");
		assert.match(q('[data-testid="voice-main"]')!.className, /max-md:size-11/);
		assert.equal(q('[data-testid="voice-main"]')!.className.includes("size-14"), false, "the mic is no longer the big circle");
		const strip = q('[data-testid="den-strip"]')!;
		assert.equal(strip.getAttribute("data-inline"), "true");
		assert.ok(strip.parentElement!.querySelector('[data-testid="chat-bar-chip"]'), "the avatars share the header line with the chip");
		assert.match(q('[data-testid="den-wolf"],[data-testid="chat-bar-swap"]')!.className, /size-11/, "44px hit area");
		const chip = q('[data-testid="chat-bar-chip"]')!;
		const title = chip.getAttribute("title")!.split(" \u00b7 ");
		assert.equal(title[0] === title[1] ? chip.querySelector('[data-testid="chat-bar-chip-wolf"]') : null, null, "a thread named like its wolf shows the name once");
	});

	it("at 320px the header line keeps one avatar plus a +N button, the name stays whole, and every control is a 44px target the tray can reveal the rest from", async () => {
		otherWolves = ["hal", "jack", "solo"];
		await mount();
		await until(() => q('[data-testid="den-more"]'), "the overflow button");
		const strip = q('[data-testid="den-strip"]')!;
		assert.equal(strip.querySelectorAll('[data-testid="den-wolf"],[data-testid="chat-bar-swap"]').length, 1, "only the current wolf has an avatar on the line");
		assert.equal(q('[data-testid="den-more"]')!.textContent, "+3");
		assert.match(strip.className, /shrink-0/, "the avatar group never squeezes the name or overlaps the buttons");
		const chip = q('[data-testid="chat-bar-chip"]')!;
		assert.match(chip.className, /min-w-24/, "the chip keeps room for a short name");
		assert.equal(q('[data-testid="bar-sheet-open"]'), null, "Open full screen is not on the header line (it lives in the settings menu)");
		assert.equal(chip.querySelector("span.truncate")!.textContent, "w/a", "the name is shown whole, not cut");
		for (const el of [...strip.querySelectorAll("button"), q('[data-testid="chat-bar-settings"]')!, q('[data-testid="chat-bar-minimize"]')!]) assert.match(el.className, /size-11|min-h-11/, `${el.getAttribute("aria-label")} is 44px`);
		assert.equal(q('[data-testid="den-more-tray"]'), null);
		await click(q('[data-testid="den-more"]'));
		assert.equal(q('[data-testid="den-more-tray"]')!.querySelectorAll('[data-testid="den-wolf"]').length, 3, "the tray lists the other wolves");
		await esc();
		assert.equal(q('[data-testid="den-more-tray"]'), null, "Escape closes the tray");
		await click(q('[data-testid="den-more"]'));
		await click(q('[data-testid="den-more-tray"] [data-testid="den-wolf"]'));
		assert.equal(q('[data-testid="den-more-tray"]'), null, "picking a wolf closes the tray");
		await click(q('[data-testid="den-more"]'));
		await act(async () => void document.dispatchEvent(new window.Event("pointerdown")));
		assert.equal(q('[data-testid="den-more-tray"]'), null, "an outside press closes the tray");
	});

	it("the compact field opens the text input too", async () => {
		await mount();
		await click(q('[data-testid="voice-field"]'));
		assert.equal(q('[data-testid="composer"]')!.getAttribute("data-field"), "text");
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

	it("a paged ask renders inline in the dock's conversation area (not a full-screen sheet), with the composer below it", async () => {
		bodies.a = { messages: [], pendingCards: [{ callId: "p1", threadId: "w/a", raisedAt: "2026-11-09T00:00:00Z", card: { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why" }], steps: [{ fields: ["q1"] }] } }] };
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		assert.equal(bar().getAttribute("data-state"), "open");
		assert.doesNotMatch(bar().getAttribute("style")!, /100dvh/);
		assert.ok(ta(), "the composer textarea is still mounted");
		for (let el: Element | null = ta(); el; el = el.parentElement) {
			assert.equal(el.hasAttribute("inert"), false);
			assert.notEqual(el.getAttribute("aria-hidden"), "true");
		}
		const order = qa('[data-testid="ask-sheet"], [data-testid="composer"]').map((e) => e.getAttribute("data-testid"));
		assert.deepEqual(order, ["ask-sheet", "composer"]);
	});

	const ASK = { callId: "p1", threadId: "w/a", raisedAt: "2026-11-09T00:00:00Z", card: { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why" }], steps: [{ fields: ["q1"] }] } };

	it("with only a pending ask (no other cards) the full-screen chevron still opens it full screen", async () => {
		bodies.a = { messages: [], pendingCards: [ASK] };
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		assert.equal(q('[data-testid="bar-strip"]'), null, "no cards, so no strip");
		await openFull();
		assert.equal(bar().getAttribute("data-state"), "sheet");
		assert.ok(q('[data-testid="ask-sheet"]'), "the ask is in the full-screen sheet");
	});

	it("an ask arriving while the owner types in the composer does not take the focus", async () => {
		await mount();
		ta().focus();
		bodies.a = { messages: [], pendingCards: [ASK] };
		await emit("thread-updated", { wolf: "w", thread: { id: "w/a", status: "needs-you" } });
		await until(() => q('[data-testid="ask-sheet"]'), "the ask to arrive");
		assert.equal(document.activeElement, ta());
	});

	it("the chevron closes the sheet and the draft survives", async () => {
		await mount();
		await type("half a thought");
		await openFull();
		assert.equal(bar().getAttribute("data-state"), "sheet");
		assert.equal(ta().value, "half a thought");
		await click(q('[data-testid="bar-sheet-close"]'));
		assert.equal(bar().getAttribute("data-state"), "open");
		assert.equal(ta().value, "half a thought");
	});

	it("a swipe down on the handle closes the sheet; a short one does not", async () => {
		await mount();
		await type("keep me");
		await openFull();
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

	it("the tree has 44px rows and always-on icon buttons on phone, inside the bar on both layouts", async () => {
		await mount();
		await click(q('[data-testid="chat-bar-chip"]'));
		assert.equal(q('[data-testid="den-sheet"]')!.getAttribute("data-layout"), "inline");
		assert.match(q('[data-testid="den-thread"]')!.className, /min-h-11/);
		assert.match(q('[data-testid="den-thread-open"]')!.className, /max-md:min-h-11/);
		await click(q('[data-testid="chat-bar-chip"]'));
		assert.equal(q('[data-testid="den-sheet"]'), null);
		await resize(false);
		await click(q('[data-testid="chat-bar-chip"]'));
		assert.equal(q('[data-testid="den-sheet"]')!.getAttribute("data-layout"), "inline");
	});

	it("the switcher lists the thread waiting on the owner first with an amber count, and picking it attaches the bar to it", async () => {
		threadStatus = { "w/c": "needs-you" };
		await mount();
		await click(q('[data-testid="chat-bar-chip"]'));
		assert.equal(q('[data-testid="den-sheet-count"]')!.textContent, "1");
		const entries = qa('[data-testid="den-thread"]');
		assert.equal(entries[0]!.getAttribute("data-thread"), "w/home", "the home thread leads");
		assert.equal(entries[1]!.getAttribute("data-thread"), "w/c", "then the waiting thread");
		assert.equal(entries[1]!.querySelector('[data-testid="den-thread-count"]')!.getAttribute("aria-label"), "1 waiting for you");
		await click(entries[1]!);
		await flush();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/c");
		assert.equal(q('[data-testid="den-sheet"]'), null, "the switcher closes after a pick");
	});

	it("the open switcher keeps its order when a status changes, showing the new status in place; the next open re-sorts", async () => {
		threadStatus = { "w/c": "needs-you" };
		await mount();
		await click(q('[data-testid="chat-bar-chip"]'));
		const order = () => qa('[data-testid="den-thread"]').map((e) => e.getAttribute("data-thread"));
		const before = order();
		assert.equal(before[1], "w/c");
		const b = () => qa('[data-testid="den-thread"]').find((e) => e.getAttribute("data-thread") === "w/b")!;
		assert.equal(b().querySelector('[data-testid="den-thread-count"]'), null);
		await emit("needs-you-changed", { wolf: "w", threadId: "w/b", status: "needs-you" });
		assert.deepEqual(order(), before, "nothing jumps under the pointer");
		assert.equal(b().querySelector('[data-testid="den-thread-count"]')?.getAttribute("aria-label"), "1 waiting for you", "the live status shows in place");
		assert.equal(q('[data-testid="den-sheet-count"]')!.textContent, "2", "the wolf's count is live too");
		await click(q('[data-testid="chat-bar-chip"]'));
		await click(q('[data-testid="chat-bar-chip"]'));
		assert.deepEqual(order().slice(1, 3).sort(), ["w/b", "w/c"], "the next open puts both waiting threads right after home");
	});

	it("picking a thread waiting on the owner shows its questionnaire in the bar", async () => {
		phone = false; // the card shows inline in the floating bar
		threadStatus = { "w/c": "needs-you" };
		bodies.c = { messages: [], pendingCards: [{ callId: "k1", threadId: "w/c", card: { tool: "ask_user_question", ...colors }, raisedAt: "2026-01-01T00:00:00Z" }] };
		await mount();
		assert.equal(q('[data-testid="bar-card"]'), null);
		await click(q('[data-testid="chat-bar-chip"]'));
		await click(qa('[data-testid="den-thread"]').find((e) => e.getAttribute("data-thread") === "w/c")!);
		await until(() => q('[data-testid="bar-card"]'), "the questionnaire");
		assert.match(q('[data-testid="bar-card"]')!.textContent!, /Which color\?/, "the question is in the bar");
	});

	it("the switcher shortcut opens it, except in visualization mode where the bar has no switcher", async () => {
		const { setVizActive } = await import("../../../components/viewer/viz-mode.ts");
		const { kbdEventForAction } = await import("../../../src/core/index.ts");
		phone = false;
		const press = () => act(async () => void window.dispatchEvent(new dom.window.CustomEvent(kbdEventForAction("chat-bar-switcher"), { detail: {} })));
		await mount();
		await press();
		assert.ok(q('[data-testid="den-sheet"]'), "the shortcut opens it");
		await click((q('[data-testid="den-thread"][aria-current="true"]')!.closest('[data-testid="den-thread-group"]')!.querySelector('[data-testid="den-thread-open"]') as HTMLElement)); // closes it
		setVizActive({ wolf: "w", threadId: "w/a" });
		try {
			await flush();
			await press();
			assert.equal(q('[data-testid="den-sheet"]'), null);
		} finally {
			setVizActive(null);
		}
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
		const { WorkReaderPanel } = await import("../../../components/work/work-reader.tsx");
		let readerClosed = 0;
		await mount(A, <WorkReaderPanel id="f1" onClose={() => void readerClosed++} />);
		await openFull();
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
		assert.equal(document.activeElement?.getAttribute("data-testid"), "chat-bar-settings", "focus returns to the settings button that held Full screen");
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

	it("reserves room for the dock on phone pages, clears it when the bar collapses to the floating icon, and when the dock goes", async () => {
		(HTMLElement.prototype as any).getBoundingClientRect = () => ({ height: 90 });
		await mount();
		assert.equal(reserve(), "90px");
		await click(q('[data-testid="chat-bar-minimize"]'));
		assert.equal(bar().getAttribute("data-state"), "minimized");
		assert.equal(reserve(), "", "the icon floats over the page: nothing to reserve");
		assert.ok(q('[data-testid="chat-bar-expand"]')!.className.includes("size-12"), "48px: above the 44px touch minimum");
		await resize(false); // desktop, minimized: no reserve
		assert.equal(reserve(), "");
	});

	it("the dock hides on the attached thread's own page (the page composer is the chat); on another thread's page it floats with a thumb-sized swap den button and reserves its height for the page; the desktop pill does the same; other pages keep it", async () => {
		const top = () => document.documentElement.style.getPropertyValue("--chat-bar-top");
		const over = () => document.documentElement.style.getPropertyValue("--chat-bar-over");
		// The pad is measured from the viewport bottom up to the bar's top (or the pill's, which floats 40px above the bar): an 800px viewport, a 90px bar.
		(window as any).innerHeight = 800;
		const barTop = () => (phone ? 710 : 698); // the dock sits flush; the desktop pill floats 12px up
		(HTMLElement.prototype as any).getBoundingClientRect = function (this: HTMLElement) {
			return this.getAttribute("data-testid") === "chat-bar-swap-wrap" ? { top: barTop() - 40, height: 30 } : { top: barTop(), height: 90 };
		};
		startPath = "/wolf/w/thread/a";
		await mount(A, undefined, false);
		assert.equal(q('[data-testid="chat-bar"]'), null, "own page");
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		startPath = "/wolf/w/thread/b";
		await mount(A);
		assert.equal(bar().getAttribute("data-layout"), "dock", "another thread page: the dock floats");
		assert.match(q('[data-testid="chat-bar-swap"]')!.className, /size-11/, "the swap den button is thumb-sized");
		assert.equal(q('[data-testid="chat-bar-swap-wrap"]'), null, "no separate swap pill any more");
		assert.equal(over(), "90px", "the page pads its bottom by the dock's height");
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		phone = false;
		await mount(A);
		assert.ok(q('[data-testid="chat-bar-swap"]'), "desktop: the pill floats over another thread page too");
		assert.equal(over(), "102px", "the bar's height plus its 12px float");
		assert.equal(top(), "102px", "--chat-bar-top is the bar top plus its 12px offset, the same as the page pad");
		await act(async () => root?.unmount());
		root = null;
		document.body.innerHTML = "";
		startPath = "/kb";
		await mount();
		assert.equal(bar().getAttribute("data-state"), "open", "desktop pill on a page with no composer");
		assert.equal(over(), "");
		assert.equal(top(), "102px", "--chat-bar-top is the bar top plus its 12px offset when there is no pill");
		await act(async () => root?.unmount());
		root = null;
		assert.equal(top(), "", "removed with the bar");
	});

	it("the page pad under the keyboard is clamped to 60% of the viewport, re-measured on a visualViewport resize (one frame), and removed in the sheet state and on unmount", async () => {
		const over = () => document.documentElement.style.getPropertyValue("--chat-bar-over");
		const all: Record<string, (() => void)[]> = {}; // several effects listen: keep every one
		const fire = (n: string) => act(async () => {
			all[n]?.forEach((cb) => cb());
			await new Promise((r) => setTimeout(r, 10)); // the coalesced frame (a 0ms timer here)
		});
		let top = 710;
		(window as any).innerHeight = 800;
		(window as any).visualViewport = { height: 800, offsetTop: 0, addEventListener: (n: string, cb: () => void) => void (all[n] ??= []).push(cb), removeEventListener() {} };
		(HTMLElement.prototype as any).getBoundingClientRect = function (this: HTMLElement) {
			return this.getAttribute("data-testid") === "chat-bar-swap-wrap" ? { top: top - 40, height: 30 } : { top, height: 90 };
		};
		startPath = "/wolf/w/thread/b";
		await mount(A);
		assert.equal(over(), "90px");
		top = 200; // the keyboard lifts the dock far up: 800 - 160 = 640 would squeeze the page to nothing
		await fire("resize");
		await flush();
		assert.equal(over(), "480px", "clamped to 60% of 800");
		top = 650;
		await fire("scroll");
		await fire("resize");
		await flush();
		assert.equal(over(), "150px", "re-measured");
		await openFull();
		await flush();
		assert.equal(bar().getAttribute("data-state"), "sheet");
		await fire("resize"); // in a browser the bar growing to full screen fires the ResizeObserver; the stub here does not
		assert.equal(over(), "", "the sheet covers the page: no pad");
		await act(async () => root?.unmount());
		root = null;
		assert.equal(over(), "", "removed on unmount");
	});

	it("shows only the icon, reserving nothing, until something is attached", async () => {
		noHome = true;
		(HTMLElement.prototype as any).getBoundingClientRect = () => ({ height: 90 });
		await mount(null, undefined, false);
		assert.equal(bar().getAttribute("data-state"), "minimized");
		assert.ok(q('[data-testid="chat-bar-expand"]'), "the icon is on the page");
		assert.equal(reserve(), "");
	});

	it("has no Dock button; swapping on another thread's page keeps the draft with its own thread", async () => {
		startPath = "/wolf/w/thread/b";
		await mount();
		assert.equal(q('[data-testid="chat-bar-dock"]'), null);
		await type("phone draft");
		await click(q('[data-testid="chat-bar-swap"]'));
		await flush();
		assert.equal(q('[data-testid="chat-bar"]'), null, "docked into the page");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/b");
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

describe("the phone dock's compact composer (work-wolfpack-qoLvFIe)", () => {
	const NOTE_ASK = { callId: "p1", threadId: "w/a", raisedAt: "2026-11-09T00:00:00Z", card: { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why" }], steps: [{ fields: ["q1"] }] } };

	it("the phone placeholder is the short 'Message <wolf>', never the thread title or the focus hint; desktop keeps its long one", async () => {
		await mount();
		assert.equal(ta().getAttribute("placeholder"), "Message w…");
		await resize(false);
		await until(() => /to focus\)$/.test(ta().getAttribute("placeholder") ?? ""), "the desktop placeholder");
		assert.match(ta().getAttribute("placeholder")!, /^Message w\/a…  \(.+ to focus\)$/);
	});

	it("in note mode the composer is one row: attach, field, mic, submit; no full-width dictation bar, and the submit is not overlaid on the field", async () => {
		bodies.a = { messages: [], pendingCards: [NOTE_ASK] };
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		const form = q('[data-testid="composer"]')!;
		const kinds = Array.from(form.children).map((c) => {
			const el = c as HTMLElement;
			if (el.getAttribute("aria-label") === "Attach images") return "attach";
			if (el.contains(ta())) return "field";
			if (el.getAttribute("data-testid") === "dictation-toggle") return "mic";
			if (el.getAttribute("type") === "submit") return "submit";
			return null;
		}).filter(Boolean);
		assert.deepEqual(kinds, ["attach", "field", "mic", "submit"]);
		assert.equal(q('[data-testid="dictation-slot"]'), null, "no full-width dictation bar slot");
		const mic = q('[data-testid="dictation-toggle"]')!;
		assert.equal(mic.getAttribute("aria-label"), "Dictate");
		assert.match(mic.className, /size-11/);
		const submit = form.querySelector('button[type="submit"]')!;
		assert.ok(!ta().parentElement!.contains(submit), "the submit sits beside the field, not inside it");
		assert.doesNotMatch(submit.className, /\babsolute\b/);
		assert.match(ta().className, /min-h-11/);
	});
});
