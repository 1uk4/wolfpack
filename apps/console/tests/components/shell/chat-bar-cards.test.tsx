/** The floating bar's cards (work-wolfpack-PtJkpk6): pending cards in the slot, wizard, "1 of N", answer / skip, Reply instead, the last-reply peek, the needs-you badge. Real mount, stubbed fetch. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { after, afterEach, describe, it, mock } from "node:test";
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
const { AttachedThreadProvider } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar } = await import("../../../components/chat-bar/chat-bar.tsx");
const { ATTACHED_KEY, BAR_EXTRAS } = await import("../../../src/core/thread/chat-bar.ts");
// The extras (cards, peek, badge, switcher) are off in the shipped floating chat; this file covers their kept code, so it switches them on.
Object.assign(BAR_EXTRAS, { cards: true, peek: true, badge: true, switcher: true });

type Call = { url: string; body?: any };
let calls: Call[] = [];
/** Per thread slug: what GET thread returns. */
let bodies: Record<string, { messages: any[]; pendingCards: any[] }> = {};
let threadStatus: Record<string, string> = {};
let extraThreads: any[] = [];
let failGet = new Set<string>();
let failPost: RegExp | null = null;
let needsYou: { wolf: string; threadId: string; raisedAt: string }[] | null = null; // null = the route fails
/** A GET of this slug waits for the promise (its snapshot is taken first: a stale response). */
let gate: { slug: string; until: Promise<void> } | null = null;
const handlers = new Map<string, (d: string) => void>();
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const emit = (n: string, d: object) => act(async () => void handlers.get(n)?.(JSON.stringify(d)));
const realFetch = globalThis.fetch;
const th = (id: string, extra: object = {}) => ({ id, title: id, kind: "feature", status: threadStatus[id] ?? "idle", ...extra });
const body = (slug: string) => bodies[slug] ?? { messages: [], pendingCards: [] };
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST" && url.endsWith("/attachments")) return Response.json({ id: "up-1", name: "a.png", mimeType: "image/png", size: 3 }, { status: 201 });
	if (init?.method === "POST") {
		calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (failPost?.test(url)) return Response.json({ error: "nope" }, { status: 500 });
		const slug = /\/threads\/([^/]+)\//.exec(url)![1]!;
		if (url.endsWith("/submit")) body(slug).pendingCards = []; // the wolf closes every pending card as superseded
		const m = /\/cards\/([^/]+)\//.exec(url);
		if (m && !url.endsWith("/text")) body(slug).pendingCards = body(slug).pendingCards.filter((p) => p.callId !== m[1]);
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
		if (gate?.slug === slug) await gate.until;
		return Response.json(snapshot);
	}
	return new Response("{}", { status: 404 });
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
async function mount(stored: object = A) {
	mem.set(ATTACHED_KEY, JSON.stringify(stored));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start="/kb">
				<ServerEventsProvider connect={fakeSource}>
					<AttachedThreadProvider>
						<ChatBar />
					</AttachedThreadProvider>
				</ServerEventsProvider>
			</FakeNav>,
		);
	});
	await until(() => q('[data-testid="composer"] textarea'), "the composer");
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
const slot = () => q('[data-testid="chat-bar-card-surface"]')!;
/** The bar's own composer(s): not the sheet's inline one. */
const bottomComposers = () => qa('[data-testid="composer"]').filter((f) => !f.closest('[data-testid="ask-inline-composer"]'));
const sendBtn = () => q('[data-testid="composer"] button[type="submit"]')!;
const switchTo = async (id: string) => {
	await click(q('[data-testid="chat-bar-chip"]'));
	await click(qa('[data-testid="switcher-entry"]').find((e) => e.getAttribute("data-thread") === id)!);
	await flush();
};

afterEach(async () => {
	mock.timers.reset();
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	calls = [];
	bodies = {};
	threadStatus = {};
	extraThreads = [];
	failGet = new Set();
	failPost = null;
	needsYou = null;
	gate = null;
	handlers.clear();
});
after(() => void (globalThis.fetch = realFetch));

const A = { wolf: "w", slug: "a", threadId: "w/a" };
const colors = { fields: [{ id: "c", kind: "single", label: "Which color?", options: [{ label: "Red", value: "red" }, { label: "Blue", value: "blue" }], allowOther: false }] };
const card = (callId: string, c: object, threadId = "w/a") => ({ callId, threadId, card: c, raisedAt: "2026-01-01T00:00:00Z" });
const q1 = (callId: string) => card(callId, { tool: "ask_user_question", ...colors });
const raise = (slug: string, ...cards: any[]) => void (bodies[slug] = { messages: bodies[slug]?.messages ?? [], pendingCards: cards });
const reply = (slug: string, text: string) => void (bodies[slug] = { pendingCards: bodies[slug]?.pendingCards ?? [], messages: [{ id: "m1", role: "assistant", text, at: "2026-01-01T00:00:00Z" }] });

describe("ChatBar cards", () => {
	it("renders the pending card in the slot and answers it through the answer route", async () => {
		raise("a", q1("c1"));
		await mount();
		assert.match(slot().textContent!, /Which color\?/);
		await click(byText("button", "Blue"));
		await click(q('[data-testid="card-submit"]'));
		await until(() => !q('[data-testid="bar-card"]'), "the answered card to leave");
		const post = calls.find((c) => c.url.endsWith("/threads/a/cards/c1/answer"))!;
		assert.deepEqual(post.body, { answers: { c: { value: "blue" } } });
	});

	it("skips through the skip route", async () => {
		raise("a", q1("c1"));
		await mount();
		await click(q('[data-testid="card-skip"]'));
		await until(() => calls.some((c) => c.url.endsWith("/threads/a/cards/c1/skip")), "the skip POST");
	});

	it("a failed answer POST keeps the card and shows the error, which survives the card going away", async () => {
		raise("a", q1("c1"));
		failPost = /\/answer$/;
		await mount();
		await click(byText("button", "Red"));
		await click(q('[data-testid="card-submit"]'));
		await until(() => q('[data-testid="bar-card-error"]'), "the error");
		assert.equal(q('[data-testid="bar-card-error"]')!.textContent, "nope");
		assert.ok(q('[data-testid="bar-card"]'), "the card is still there to retry");
		raise("a"); // answered elsewhere: the refetch removes the card, the error line stays
		await emit("thread-updated", { wolf: "w", thread: { id: "w/a", status: "idle" } });
		await until(() => !q('[data-testid="bar-card"]'), "the card to go");
		assert.equal(q('[data-testid="bar-card-error"]')!.textContent, "nope");
	});

	it("a refetch that started before an answer does not bring the answered card back", async () => {
		raise("a", q1("c1"));
		await mount();
		let release!: () => void;
		gate = { slug: "a", until: new Promise<void>((r) => (release = r)) };
		await emit("thread-updated", { wolf: "w", thread: { id: "w/a", status: "idle" } }); // snapshot still has c1
		gate = null;
		await click(byText("button", "Red"));
		await click(q('[data-testid="card-submit"]'));
		await until(() => !q('[data-testid="bar-card"]'), "the answered card to leave");
		release();
		await flush();
		assert.equal(q('[data-testid="bar-card"]'), null);
	});

	it("steps a multi-step card through a wizard and shows one card at a time, oldest first, with a counter", async () => {
		const two = { fields: [{ id: "x", kind: "free-text", label: "First?" }, { id: "y", kind: "confirm", label: "Second?" }], steps: [{ fields: ["x"] }, { fields: ["y"] }] };
		raise("a", card("c1", { tool: "ask_user_question", ...two }), q1("c2"));
		await mount();
		assert.equal(q('[data-testid="bar-card-counter"]')!.textContent, "1 of 2");
		assert.match(slot().textContent!, /Step 1 of 2/);
		assert.doesNotMatch(slot().textContent!, /Which color/);
		const input = q('[data-field="x"] textarea, [data-field="x"] input') as HTMLTextAreaElement;
		await act(async () => {
			input.value = "hi";
			props(input, "onChange")({ target: input, currentTarget: input });
		});
		await click(q('[data-testid="card-next"]'));
		await until(() => /Step 2 of 2/.test(slot().textContent!), "step 2");
	});

	it("a paged ask opens the sheet; the answering chip routes typed text to the question, plain typing to a normal message", async () => {
		const paged = {
			callId: "p1",
			threadId: "w/a",
			raisedAt: "2026-11-09T00:00:00+00:00",
			card: { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why", optional: true }, { id: "q2", kind: "free-text", label: "How", optional: true }], steps: [{ fields: ["q1", "q2"] }] },
		};
		raise("a", paged);
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		assert.equal(q('[data-testid="bar-card"]'), null); // not the classic card path
		assert.equal(q('[data-testid="ask-replace-hint"]'), null);
		await type("typed");
		assert.equal(q('[data-testid="ask-replace-hint"]') === null, true); // while the sheet is open, typing is its note, not a replacing message
		assert.match(sendBtn().textContent!, /Submit/); // the composer button is the sheet's (last page)
		await type("");
		assert.equal(bottomComposers().length, 1);
		await click(qa('[data-testid="ask-free"], [data-testid="ask-other"]')[1]!);
		assert.match(q('[data-testid="answering-chip"]')!.textContent!, /Replying to: How/);
		assert.equal(bottomComposers().length, 0); // the bar's composer gives way to the one in the sheet
		assert.equal(q('[data-testid="composer-controls"]') === null, true);
		await type("because");
		await submit();
		await until(() => calls.some((c) => c.url.endsWith("/cards/p1/questions/q2/text")), "the bind POST");
		assert.deepEqual(calls.find((c) => c.url.endsWith("/text"))!.body, { text: "because" });
		assert.equal(calls.some((c) => c.url.endsWith("/submit")), false);
		assert.equal(q('[data-testid="answering-chip"]') === null, true);
		assert.equal(bottomComposers().length, 1); // bound: the bar's composer is back
	});

	it("a plain message after collapsing supersedes only the thread's own questionnaires: a subagent's stays queued", async () => {
		const page = { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why", optional: true }], steps: [{ fields: ["q1"] }] };
		const kid = { ...card("k1", page, "w/kid"), source: { kind: "subagent", label: "worker: sheet" } };
		const mine = { ...card("m1", page), source: { kind: "self", label: "you" } };
		raise("a", kid, mine);
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		assert.equal(q('[data-testid="ask-queue-label"]')!.textContent, "1 of 2 \u00b7 worker: sheet");
		await click(q('[data-testid="ask-collapse"]'));
		assert.equal(q('[data-testid="ask-sheet-reopen"]')!.textContent!.includes("Questions waiting (2)"), true);
		await type("never mind");
		await submit();
		await until(() => calls.some((c) => c.url.endsWith("/threads/a/submit")), "the plain message");
		await flush();
		assert.equal(q('[data-testid="ask-sheet-reopen"]')!.textContent!.includes("Questions waiting"), true);
		assert.equal(q('[data-testid="ask-sheet-reopen"]')!.textContent!.includes("("), false); // only the child's is left: no count
		await click(q('[data-testid="ask-sheet-reopen"]'));
		assert.equal(q('[data-testid="ask-sheet"]')!.getAttribute("data-call-id"), "k1");
	});

	it("the answering chip clears when its question leaves the page; a text-only send cannot go out empty; other cards still show beside the sheet", async () => {
		const fields = [{ id: "q1", kind: "free-text", label: "Why", optional: true }, { id: "q2", kind: "free-text", label: "How", optional: true }];
		const paged = (steps: object[], pageIndex = 0) => ({ callId: "p1", threadId: "w/a", raisedAt: "2026-11-09T00:00:00+00:00", pageIndex, card: { tool: "ask", paged: true, fields, steps } });
		raise("a", paged([{ fields: ["q1", "q2"] }, { fields: [] }]), q1("c1"));
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		assert.match(slot().textContent!, /Which color\?/); // the classic card shows beside the sheet
		await click(qa('[data-testid="ask-free"], [data-testid="ask-other"]')[1]!);
		assert.match(q('[data-testid="answering-chip"]')!.textContent!, /Replying to: How/);
		assert.equal(sendBtn().hasAttribute("disabled") || sendBtn().getAttribute("aria-disabled") === "true", true); // nothing typed: no send
		raise("a", paged([{ fields: ["q1"] }, { fields: ["q2"] }]), q1("c1"));
		await emit("thread-updated", { wolf: "w", thread: { id: "w/a", status: "idle" } });
		await until(() => q('[data-testid="answering-chip"]') === null, "the chip to clear");
		assert.equal(bottomComposers().length, 1);
	});

	it("reply mode: an attached image binds with the text, alone it still sends, and a refused bind keeps text and image", async () => {
		raise("a", { callId: "p1", threadId: "w/a", raisedAt: "2026-11-09T00:00:00+00:00", card: { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why", optional: true }], steps: [{ fields: ["q1"] }] } });
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		const pick = async () => {
			const input = q('[data-testid="attachment-picker"]') as HTMLInputElement;
			await act(async () => void props(input, "onChange")({ target: Object.assign(input, { files: [new File(["abc"], "a.png", { type: "image/png" })], value: "" }) }));
			await until(() => q(`[data-testid="attachment-chip"][data-status="ready"]`), "the upload");
		};
		const texts = () => calls.filter((c) => c.url.endsWith("/cards/p1/questions/q1/text"));
		await click(q('[data-testid="ask-free"], [data-testid="ask-other"]'));
		assert.equal(props(q('button[aria-label="Attach images"]')!, "disabled"), false);
		failPost = /\/text$/; // refused, e.g. over the card's image cap
		await pick();
		await type("look");
		await submit();
		await until(() => q('[role="alert"]'), "the inline error");
		assert.deepEqual(texts()[0]!.body, { text: "look", attachments: ["up-1"] });
		assert.equal(q('[role="alert"]')!.textContent, "nope");
		assert.equal(ta().value, "look");
		assert.equal(qa('[data-testid="attachment-chip"]').length, 1);
		failPost = null;
		await submit();
		await until(() => texts().length === 2, "the retry");
		await until(() => qa('[data-testid="attachment-chip"]').length === 0, "the chips to clear");
		await click(qa('[data-testid="ask-free"], [data-testid="ask-other"]')[0]!);
		await pick();
		await submit();
		await until(() => texts().length === 3, "the image-only bind");
		assert.deepEqual(texts()[2]!.body, { text: "look", attachments: ["up-1"] }); // reopening the answered field seeds the composer with its answer (one text), so the image binds with it
	});

	it("reply mode: a double Send posts the answer once and the second Send cannot overwrite it with an empty one", async () => {
		raise("a", { callId: "p1", threadId: "w/a", raisedAt: "2026-11-09T00:00:00+00:00", card: { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why", optional: true }], steps: [{ fields: ["q1"] }] } });
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		await click(q('[data-testid="ask-free"], [data-testid="ask-other"]'));
		const input = q('[data-testid="attachment-picker"]') as HTMLInputElement;
		await act(async () => void props(input, "onChange")({ target: Object.assign(input, { files: [new File(["abc"], "a.png", { type: "image/png" })], value: "" }) }));
		await until(() => q(`[data-testid="attachment-chip"][data-status="ready"]`), "the upload");
		await type("look");
		let release!: () => void;
		const held = new Promise<void>((r) => (release = r));
		const inner = globalThis.fetch;
		globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
			if (init?.method === "POST" && String(i).endsWith("/text")) await held;
			return inner(i, init);
		}) as typeof fetch;
		try {
			await submit();
			await submit(); // the round trip is still open
			release();
			await until(() => calls.some((c) => c.url.endsWith("/text")), "the bind");
		} finally {
			globalThis.fetch = inner;
		}
		assert.deepEqual(calls.filter((c) => c.url.endsWith("/cards/p1/questions/q1/text")).map((c) => c.body), [{ text: "look", attachments: ["up-1"] }]);
	});

	it("reply mode: Esc, × and a click outside leave it, keep the unsent text, and bring the bar's composer and the replace hint back", async () => {
		raise("a", { callId: "p1", threadId: "w/a", raisedAt: "2026-11-09T00:00:00+00:00", card: { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why", optional: true }], steps: [{ fields: ["q1"] }] } });
		await mount();
		await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
		await click(q('[data-testid="ask-free"], [data-testid="ask-other"]'));
		await type("half");
		await act(async () => void props(ta(), "onKeyDown")({ key: "Escape", preventDefault() {}, stopPropagation() {} }));
		assert.equal(q('[data-testid="answering-chip"]') === null, true);
		assert.equal(bottomComposers().length, 1);
		assert.match(q('[data-testid="ask-unsent"]')!.textContent!, /Unsent: half/);
		await click(qa('[data-testid="ask-free"], [data-testid="ask-other"]')[0]!);
		assert.equal(bottomComposers().length, 0);
		await click(q('[data-testid="answering-chip-clear"]'));
		assert.equal(bottomComposers().length, 1);
		await click(qa('[data-testid="ask-free"], [data-testid="ask-other"]')[0]!);
		await act(async () => void document.body.dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		assert.equal(q('[data-testid="answering-chip"]') === null, true);
		assert.equal(bottomComposers().length, 1);
		await type("typed");
		assert.equal(q('[data-testid="ask-replace-hint"]') === null, true); // while the sheet is open, typing is its note, not a replacing message
		assert.match(sendBtn().textContent!, /Submit/); // the composer button is the sheet's (last page)
	});

	it("keeps the input usable with a card open; Reply instead supersedes the card and shows it superseded", async () => {
		raise("a", q1("c1"));
		await mount();
		assert.equal(ta().disabled, false);
		await type("never mind");
		assert.equal(sendBtn().textContent, "Reply instead");
		await submit();
		await until(() => q('[data-testid="card-closed-badge"]'), "the superseded badge");
		assert.equal(calls.find((c) => c.url.endsWith("/threads/a/submit"))!.body.input, "never mind");
		assert.equal(q('[data-testid="card-closed-badge"]')!.getAttribute("data-closed"), "superseded");
		assert.equal(q('[data-testid="bar-card"]'), null);
	});

	it("keeps Stop for an empty input while a turn runs with a card open", async () => {
		raise("a", q1("c1"));
		threadStatus["w/a"] = "busy";
		await mount();
		assert.equal(sendBtn().getAttribute("aria-label"), "Stop");
		assert.equal(sendBtn().textContent, "");
	});

	it("a failed send leaves the card open and not superseded", async () => {
		raise("a", q1("c1"));
		failPost = /\/submit$/;
		await mount();
		await type("never mind");
		await submit();
		await until(() => calls.some((c) => c.url.endsWith("/submit")), "the submit");
		await flush();
		assert.ok(q('[data-testid="bar-card"]'));
		assert.equal(q('[data-testid="card-closed-badge"]'), null);
	});

	it("the superseded card leaves the bar after 4 seconds", async () => {
		raise("a", q1("c1"));
		await mount();
		await type("never mind");
		mock.timers.enable({ apis: ["setTimeout"] });
		await submit();
		await until(() => q('[data-testid="bar-card-superseded"]'), "the superseded card");
		await act(async () => mock.timers.tick(3900));
		assert.ok(q('[data-testid="bar-card-superseded"]'), "still shown before 4s");
		await act(async () => mock.timers.tick(200));
		assert.equal(q('[data-testid="bar-card-superseded"]'), null);
	});

	it("a zero-question brief shows the headline and an OK that acknowledges it", async () => {
		raise("a", card("b1", { tool: "brief", brief: { headline: "Shipped it" }, fields: [] }));
		await mount();
		assert.equal(q('[data-testid="brief-headline"]')!.textContent, "Shipped it");
		assert.equal(q('[data-testid="card-submit"]')!.textContent, "OK");
		await click(q('[data-testid="card-submit"]'));
		await until(() => calls.some((c) => c.url.endsWith("/cards/b1/answer")), "the answer POST");
		assert.deepEqual(calls.find((c) => c.url.endsWith("/cards/b1/answer"))!.body, { answers: {} });
	});

	describe("producers", () => {
		// Tool confirmations are paged ask cards (source kind "tool"): they join the questionnaire sheet queue, not the classic card path.
		const tool = (callId: string, name: string, c: object) => ({ ...card(callId, { tool: name, paged: true, ...c }), source: { kind: "tool", label: name } });

		it("a task_done multi-ship card opens in the sheet with its boxes ticked, names its tool, and Submit posts the ships", async () => {
			const ship = tool("s1", "task_done", { fields: [{ id: "ships", kind: "multi", label: "Ship these 2 tasks?", options: [{ label: "One (t1)", value: "t1" }, { label: "Two (t2)", value: "t2" }], default: ["t1", "t2"], min: 1, allowOther: false }], steps: [{ title: "Ship", fields: ["ships"] }] });
			raise("a", ship);
			await mount();
			await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
			assert.equal(q('[data-testid="bar-card"]'), null); // not the classic card path
			assert.equal(q('[data-testid="ask-source"]')!.textContent, "task_done"); // a lone tool card: the label sits by the title (no counter)
			assert.equal(q('[data-testid="ask-queue"]') === null, true);
			assert.deepEqual(qa('[data-testid="ask-option"]').map((o) => o.getAttribute("aria-checked")), ["true", "true"]);
			await submit();
			await until(() => calls.some((c) => c.url.endsWith("/cards/s1/submit")), "the submit POST");
			assert.deepEqual(calls.find((c) => c.url.endsWith("/cards/s1/submit"))!.body.answers, { ships: { value: ["t1", "t2"] } });
		});

		it("a tool confirmation queues beside a subagent's questionnaire as 1 of 2 with its tool name", async () => {
			const conf = tool("s2", "task_graduate", { fields: [{ id: "ok", kind: "confirm", label: "Graduate it?" }], steps: [{ fields: ["ok"] }] });
			const kid = { ...card("k1", { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why", optional: true }], steps: [{ fields: ["q1"] }] }, "w/kid"), source: { kind: "subagent", label: "worker: sheet" } };
			raise("a", conf, kid);
			await mount();
			await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
			assert.equal(q('[data-testid="ask-queue-label"]')!.textContent, "1 of 2 \u00b7 task_graduate");
		});

		it("a single-confirm tool card (task_done 'Ship X?') is required: no Skip, a typed note never arms 'Send anyway?', and Submit posts the confirm", async () => {
			const ship = tool("s3", "task_done", { title: "Ship?", fields: [{ id: "confirm", kind: "confirm", label: "Ship X?" }], steps: [{ title: "Ship?", fields: ["confirm"] }] });
			raise("a", ship);
			await mount();
			await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
			assert.equal(q('[data-testid="ask-skip"]'), null);
			assert.equal(sendBtn().hasAttribute("disabled") || sendBtn().getAttribute("aria-disabled") === "true", true);
			await type("just a note");
			await submit();
			await submit();
			await flush();
			assert.equal(calls.some((c) => c.url.endsWith("/submit")), false, "nothing is sent while the confirm is unanswered");
			assert.doesNotMatch(sendBtn().textContent ?? "", /Send anyway/);
			await click(qa('[data-testid="ask-confirm"]').find((b) => b.getAttribute("data-value") === "true")!);
			await submit();
			await until(() => calls.some((c) => c.url.endsWith("/cards/s3/submit")), "the submit POST");
			assert.deepEqual(calls.find((c) => c.url.endsWith("/cards/s3/submit"))!.body.answers, { confirm: { value: true } });
		});

		it("the subagent_stop abandon card (confirmCard with Abandon / Keep) renders in the sheet and Submit posts the choice", async () => {
			const gone = tool("ab1", "subagent_stop", { title: "Abandon branch?", fields: [{ id: "confirm", kind: "confirm", label: "Abandon feat/x (2 unmerged commits)?", description: "Its worktree is deleted.", confirmLabel: "Abandon", rejectLabel: "Keep" }], steps: [{ title: "Abandon branch?", fields: ["confirm"] }] });
			raise("a", gone);
			await mount();
			await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
			assert.deepEqual(qa('[data-testid="ask-confirm"]').map((b) => b.textContent?.trim()), ["Abandon", "Keep"]);
			assert.equal(q('[data-testid="ask-skip"]'), null);
			await click(qa('[data-testid="ask-confirm"]').find((b) => b.textContent?.trim() === "Abandon")!);
			await submit();
			await until(() => calls.some((c) => c.url.endsWith("/cards/ab1/submit")), "the submit POST");
			assert.deepEqual(calls.find((c) => c.url.endsWith("/cards/ab1/submit"))!.body.answers, { confirm: { value: true } });
		});

		it("a plain message after collapsing supersedes the thread's own tool confirmation; a subagent's card stays", async () => {
			const conf = tool("s4", "task_graduate", { fields: [{ id: "ok", kind: "confirm", label: "Graduate it?" }], steps: [{ fields: ["ok"] }] });
			const kid = { ...card("k1", { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why", optional: true }], steps: [{ fields: ["q1"] }] }, "w/kid"), source: { kind: "subagent", label: "worker: sheet" } };
			raise("a", conf, kid);
			await mount();
			await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
			await click(q('[data-testid="ask-collapse"]'));
			await type("never mind");
			await submit();
			await until(() => calls.some((c) => c.url.endsWith("/threads/a/submit")), "the plain message");
			await flush();
			// The tool card is gone; the child's stays and a new card opens expanded.
			assert.equal(q('[data-testid="ask-sheet"]')!.getAttribute("data-call-id"), "k1");
			assert.equal(q('[data-testid="ask-queue"]'), null);
		});

		it("a crawl_release single chooser (options without a tradeoff) renders in the sheet and submits the picked run", async () => {
			const rel = tool("r1", "crawl_release", { title: "Release which crawl?", fields: [{ id: "run", kind: "single", label: "Pick a crawl — newest first.", options: [{ label: "Crawl A", value: "/runs/a" }, { label: "Crawl B", value: "/runs/b" }], allowOther: false }], steps: [{ fields: ["run"] }] });
			raise("a", rel);
			await mount();
			await until(() => q('[data-testid="ask-sheet"]'), "the ask sheet");
			assert.equal(q('[data-testid="ask-tradeoff"]') === null, true);
			await click(qa('[data-testid="ask-option"]').find((o) => o.textContent!.includes("Crawl B"))!);
			await submit();
			await until(() => calls.some((c) => c.url.endsWith("/cards/r1/submit")), "the submit POST");
			assert.deepEqual(calls.find((c) => c.url.endsWith("/cards/r1/submit"))!.body.answers, { run: { value: "/runs/b" } });
		});
	});
});

describe("ChatBar thread switch", () => {
	it("drops a fetch for the old thread that lands after the switch", async () => {
		raise("a", q1("c1"));
		let release!: () => void;
		gate = { slug: "a", until: new Promise<void>((r) => (release = r)) };
		await mount(); // A's fetch hangs
		await switchTo("w/b");
		release();
		await flush();
		assert.equal(q('[data-testid="bar-card"]'), null);
		assert.doesNotMatch(slot().textContent ?? "", /Which color/);
	});

	it("a failed fetch after a switch shows nothing from the old thread", async () => {
		raise("a", q1("c1"));
		await mount();
		assert.ok(q('[data-testid="bar-card"]'));
		failGet.add("b");
		await switchTo("w/b");
		assert.equal(q('[data-testid="bar-card"]'), null);
		assert.equal(slot().textContent, "");
	});
});

describe("ChatBar peek", () => {
	const turn = async (text: string) => {
		threadStatus["w/a"] = "busy";
		await emit("needs-you-changed", { wolf: "w", threadId: "w/a", status: "busy" });
		reply("a", text);
		threadStatus["w/a"] = "idle";
		await emit("thread-updated", { wolf: "w", thread: { id: "w/a", status: "idle" } });
		await flush();
	};

	it("shows the last reply after a turn, and clears on dismiss and on send", async () => {
		await mount();
		assert.equal(q('[data-testid="bar-peek"]'), null, "no peek before a turn ended");
		await turn("All done here");
		assert.match(q('[data-testid="bar-peek-text"]')!.textContent!, /All done here/);
		await click(q('[data-testid="bar-peek-dismiss"]'));
		assert.equal(q('[data-testid="bar-peek"]'), null);
		await turn("Second reply");
		assert.match(q('[data-testid="bar-peek-text"]')!.textContent!, /Second reply/);
		await type("thanks");
		await submit();
		await flush();
		assert.equal(q('[data-testid="bar-peek"]'), null);
	});

	it("clears when the bar is switched to another thread", async () => {
		await mount();
		await turn("All done here");
		assert.ok(q('[data-testid="bar-peek"]'));
		await switchTo("w/b");
		assert.equal(q('[data-testid="bar-peek"]'), null);
	});

	it("does not come back once a card was answered, nor while the wolf is working again", async () => {
		await mount();
		await turn("Old reply");
		raise("a", q1("c1"));
		await emit("thread-updated", { wolf: "w", thread: { id: "w/a", status: "idle" } });
		await until(() => q('[data-testid="bar-card"]'), "the card");
		assert.equal(q('[data-testid="bar-peek"]'), null, "a card hides the peek");
		await click(byText("button", "Red"));
		await click(q('[data-testid="card-submit"]'));
		await until(() => !q('[data-testid="bar-card"]'), "the card to go");
		await flush();
		assert.equal(q('[data-testid="bar-peek"]'), null, "answering does not bring the old reply back");
	});

	it("goes away when a new turn starts", async () => {
		await mount();
		await turn("All done here");
		assert.ok(q('[data-testid="bar-peek"]'));
		threadStatus["w/a"] = "busy";
		await emit("needs-you-changed", { wolf: "w", threadId: "w/a", status: "busy" });
		await flush();
		assert.equal(q('[data-testid="bar-peek"]'), null);
	});
});

describe("ChatBar needs-you badge", () => {
	it("counts waiting threads elsewhere (not the attached one, not subagents); one tap attaches the first", async () => {
		threadStatus = { "w/a": "needs-you", "w/b": "needs-you", "w/c": "needs-you", "w/sub": "needs-you" };
		extraThreads = [th("w/sub", { kind: "subagent", parentThreadId: "w/b" })];
		await mount();
		const badge = q('[data-testid="chat-bar-needs-you"]')!;
		assert.equal(badge.textContent, "2");
		assert.equal(badge.getAttribute("aria-label"), "2 waiting for you. Attach the bar to w/b");
		await click(badge);
		await flush();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/b");
		const next = q('[data-testid="chat-bar-needs-you"]')!;
		assert.equal(next.textContent, "2", "w/a (no longer attached) and w/c wait now");
		assert.equal(next.getAttribute("data-thread"), "w/a");
	});
});

describe("ChatBar needs-you badge order", () => {
	it("taps to the thread whose oldest card was raised first, even when list order disagrees", async () => {
		threadStatus = { "w/b": "needs-you", "w/c": "needs-you" };
		needsYou = [
			{ wolf: "w", threadId: "w/b", raisedAt: "2026-01-02T00:00:00Z" },
			{ wolf: "w", threadId: "w/c", raisedAt: "2026-01-01T00:00:00Z" },
			{ wolf: "w", threadId: "w/b", raisedAt: "2026-01-03T00:00:00Z" },
		];
		await mount();
		assert.equal(q('[data-testid="chat-bar-needs-you"]')!.getAttribute("data-thread"), "w/c");
		assert.match(q('[data-testid="chat-bar-needs-you"]')!.getAttribute("title")!, /oldest: w\/c/);
		await click(q('[data-testid="chat-bar-needs-you"]'));
		await flush();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/c");
	});

	it("falls back to list order when the route fails, and re-sorts on needs-you-changed", async () => {
		threadStatus = { "w/b": "needs-you", "w/c": "needs-you" };
		await mount();
		assert.equal(q('[data-testid="chat-bar-needs-you"]')!.getAttribute("data-thread"), "w/b");
		needsYou = [{ wolf: "w", threadId: "w/c", raisedAt: "2026-01-01T00:00:00Z" }];
		await emit("needs-you-changed", { wolf: "w", kind: "card" });
		await until(() => q('[data-testid="chat-bar-needs-you"]')!.getAttribute("data-thread") === "w/c", "the re-sort");
	});
});

describe("architecture", () => {
	it("no session module is reachable from the bar's runtime imports", () => {
		const root = resolve(dirname(new URL(import.meta.url).pathname), "..", "..", "..");
		const resolveSpec = (from: string, spec: string): string | null => {
			const base = spec.startsWith("@/") ? resolve(root, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
			if (!base) return null;
			for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) if (existsSync(base + ext) && /\.(tsx?)$/.test(base + ext)) return base + ext;
			return null;
		};
		const seen = new Set<string>();
		const walk = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			const src = readFileSync(file, "utf8");
			// Runtime edges only: `import type` / `export type` are erased.
			const re = /(?:^|\n)\s*(?:import|export)(?!\s+type\b)[^;'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s*["']([^"']+)["']/g;
			for (const m of src.matchAll(re)) {
				const dep = resolveSpec(file, (m[1] ?? m[2] ?? m[3])!);
				if (dep) walk(dep);
			}
		};
		walk(resolve(root, "components/chat-bar/chat-bar.tsx"));
		const names = [...seen].map((f) => f.slice(root.length + 1));
		assert.ok(names.includes("components/chat-bar/chat-bar-composer.tsx") && names.includes("components/chat-bar/bar-card-surface.tsx"), "the walk reaches the lazy halves");
		const bad = names.filter((n) => /(^|\/)(session|session-core|use-chat-session)\.tsx?$/.test(n));
		assert.deepEqual(bad, []);
	});
});
