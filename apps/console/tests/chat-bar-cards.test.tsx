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

const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { FakeNav } = await import("./helpers/fake-nav.tsx");
const { AttachedThreadProvider } = await import("../components/attached-thread.tsx");
const { ChatBar } = await import("../components/chat-bar.tsx");
const { ATTACHED_KEY } = await import("../src/core/chat-bar.ts");

type Call = { url: string; body?: any };
let calls: Call[] = [];
/** Per thread slug: what GET thread returns. */
let bodies: Record<string, { messages: any[]; pendingCards: any[] }> = {};
let threadStatus: Record<string, string> = {};
let extraThreads: any[] = [];
let failGet = new Set<string>();
let failPost: RegExp | null = null;
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
	if (init?.method === "POST") {
		calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (failPost?.test(url)) return Response.json({ error: "nope" }, { status: 500 });
		const slug = /\/threads\/([^/]+)\//.exec(url)![1]!;
		if (url.endsWith("/submit")) body(slug).pendingCards = []; // the wolf closes every pending card as superseded
		const m = /\/cards\/([^/]+)\//.exec(url);
		if (m) body(slug).pendingCards = body(slug).pendingCards.filter((p) => p.callId !== m[1]);
		return new Response(JSON.stringify({ disposition: "started" }), { status: 200 });
	}
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
		it("task_done multi-select ship card answers with the ticked ids", async () => {
			const ship = { tool: "task_done", fields: [{ id: "ships", kind: "multi", label: "Ship these 2 tasks?", options: [{ label: "One (t1)", value: "t1" }, { label: "Two (t2)", value: "t2" }], default: ["t1", "t2"], min: 1, allowOther: false }] };
			raise("a", card("s1", ship));
			await mount();
			assert.match(slot().textContent!, /Ship these 2 tasks\?/);
			await click(q('[data-testid="card-submit"]'));
			await until(() => calls.some((c) => c.url.endsWith("/cards/s1/answer")), "the answer POST");
			assert.deepEqual(calls.find((c) => c.url.endsWith("/cards/s1/answer"))!.body, { answers: { ships: { value: ["t1", "t2"] } } });
		});

		it("task_done single ship card (confirm) answers yes", async () => {
			const ship = { tool: "task_done", brief: { headline: 'Ship "Fix it"?' }, fields: [{ id: "ok", kind: "confirm", label: 'Ship "Fix it" (t1)?', confirmLabel: "Ship", rejectLabel: "Not yet" }] };
			raise("a", card("s2", ship));
			await mount();
			assert.equal(q('[data-testid="brief-headline"]')!.textContent, 'Ship "Fix it"?');
			await click(q('[data-testid="card-confirm"]'));
			await click(q('[data-testid="card-submit"]'));
			await until(() => calls.some((c) => c.url.endsWith("/cards/s2/answer")), "the answer POST");
			assert.deepEqual(calls.find((c) => c.url.endsWith("/cards/s2/answer"))!.body, { answers: { ok: { value: true } } });
		});

		it("a subagent abandon card (confirm) is skippable", async () => {
			const stop = { tool: "subagent_stop", brief: { headline: "Abandon the worker?" }, fields: [{ id: "ok", kind: "confirm", label: "Abandon worker w1?", confirmLabel: "Abandon", rejectLabel: "Keep" }] };
			raise("a", card("p1", stop));
			await mount();
			assert.match(slot().textContent!, /Abandon worker w1\?/);
			await click(q('[data-testid="card-skip"]'));
			await until(() => calls.some((c) => c.url.endsWith("/cards/p1/skip")), "the skip POST");
		});

		it("a crawl_release card (single choice) answers with the picked run", async () => {
			const rel = { tool: "crawl_release", title: "Release which crawl?", brief: { headline: "Release which crawl?" }, fields: [{ id: "run", kind: "single", label: "Pick a crawl — newest first.", options: [{ label: "Crawl A", value: "/runs/a" }, { label: "Crawl B", value: "/runs/b" }], allowOther: false }] };
			raise("a", card("r1", rel));
			await mount();
			await click(byText("button", "Crawl B"));
			await click(q('[data-testid="card-submit"]'));
			await until(() => calls.some((c) => c.url.endsWith("/cards/r1/answer")), "the answer POST");
			assert.deepEqual(calls.find((c) => c.url.endsWith("/cards/r1/answer"))!.body, { answers: { run: { value: "/runs/b" } } });
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

describe("architecture", () => {
	it("no session module is reachable from the bar's runtime imports", () => {
		const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
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
		walk(resolve(root, "components/chat-bar.tsx"));
		const names = [...seen].map((f) => f.slice(root.length + 1));
		assert.ok(names.includes("components/chat-bar-composer.tsx") && names.includes("components/bar-card-surface.tsx"), "the walk reaches the lazy halves");
		const bad = names.filter((n) => /(^|\/)(session|session-core|use-chat-session)\.tsx?$/.test(n));
		assert.deepEqual(bad, []);
	});
});
