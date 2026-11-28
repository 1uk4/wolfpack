/** ChatBar + AttachedThreadProvider (real mount, stubbed fetch): send/steer/stop, per-thread drafts, collapse on the thread's own page, switcher, work-item attach. */
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
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

const { usePathname } = await import("next/navigation");
const { dataStore } = await import("../../../src/core/data-store.ts");
const { AppRouterContext: await_ctx } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { KeyboardShortcuts } = await import("../../../components/shell/keyboard-shortcuts.tsx");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");
const { AttachedThreadProvider, useAttachedThread } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar, submitToThread } = await import("../../../components/chat-bar/chat-bar.tsx");
const { ATTACHED_KEY, BAR_EXTRAS } = await import("../../../src/core/thread/chat-bar.ts");

type Call = { url: string; body?: any };
let calls: Call[] = [];
let status: "idle" | "busy" = "idle";
let bNeedsYou = false; // thread w/b waits on the owner
let secondWolfDown = false; // a second wolf is listed but its thread list does not load yet (the lists are incomplete)
let noHome = false; // the wolf has no home thread: nothing to auto-attach
let holdSubmit: Promise<void> | null = null; // a send's POST stays in flight until this settles
let archived = false;
let kids: object[] = [];
let gets: string[] = [];
const handlers = new Map<string, (d: string) => void>();
let fireOpen: (() => void) | null = null; // the event source's (re)open: the app's resync
const fakeSource = () => ({ close() {}, onOpen: (cb: () => void) => void (fireOpen = cb), onEvent: (n: string, cb: (d: string) => void) => void handlers.set(n, cb) });
const emit = (n: string, d: object) => act(async () => void handlers.get(n)?.(JSON.stringify(d)));
const realFetch = globalThis.fetch;
const th = (id: string, extra: object = {}) => ({ id, title: id, kind: "feature", status, ...extra });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST") {
		calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
		if (holdSubmit && url.endsWith("/threads/a/submit")) await holdSubmit;
		return new Response("{}", { status: 200 });
	}
	if (init?.method !== "POST") gets.push(url);
	if (url.endsWith("/threads/a/children")) return Response.json({ threads: kids });
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }, ...(secondWolfDown ? [{ name: "v" }] : [])] });
	if (url === "/api/wolves/v/threads") return secondWolfDown ? new Response("{}", { status: 503 }) : Response.json({ threads: [] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [...(noHome ? [] : [th("w/home", { kind: "home" })]), th("w/a", archived ? { closed: true } : {}), th("w/b", bNeedsYou ? { status: "needs-you" } : {})] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

let root: Root | null = null;
const wait = (ms = 60) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function mount(start: string, stored?: object, extra?: React.ReactNode) {
	if (stored) mem.set(ATTACHED_KEY, JSON.stringify(stored));
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={start}>
				<ServerEventsProvider connect={fakeSource}>
					<AttachedThreadProvider>
						<ChatBar />
						{extra}
					</AttachedThreadProvider>
				</ServerEventsProvider>
			</FakeNav>,
		);
	});
	await wait();
}
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const ta = () => q('[data-testid="composer"] textarea') as HTMLTextAreaElement;
const type = (v: string) =>
	act(async () => {
		const el = ta();
		el.value = v;
		const key = Object.keys(el).find((k) => k.startsWith("__reactProps$"))!;
		(el as any)[key].onChange({ target: el, currentTarget: el });
	});
const click = (el: HTMLElement | null) =>
	act(async () => {
		const key = Object.keys(el!).find((k) => k.startsWith("__reactProps$"))!;
		(el as any)[key].onClick({ currentTarget: el, target: el, preventDefault() {}, stopPropagation() {} });
	});
const submit = () => act(async () => void ta().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));

afterEach(async () => {
	dataStore.clear(); // the thread list goes through the client store: the next test must not read this one's list
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	calls = [];
	status = "idle";
	bNeedsYou = false;
	noHome = false;
	secondWolfDown = false;
	fireOpen = null;
	holdSubmit = null;
	archived = false;
	kids = [];
	gets = [];
	handlers.clear();
});
after(() => void (globalThis.fetch = realFetch));

const A = { wolf: "w", slug: "a", threadId: "w/a" };

/** Test stand-in for what starting dictation on a thread page does (attach it); the product has no Pop out button. */
function AttachHere() {
	const api = useAttachedThread();
	return <button type="button" data-testid="test-attach" onClick={() => api!.attach({ wolf: "w", threadId: "w/a", slug: "a" })} />;
}

describe("ChatBar", () => {
	it("with nothing attached the owner's home thread attaches on its own, and the old home-wolf default is cleared", async () => {
		mem.set("wolfpack:chatbar:attached", JSON.stringify(A));
		mem.set("wolfpack:chatbar:home-wolf", "w");
		await mount("/kb");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/home");
		assert.ok(q('[data-testid="chat-bar"]'), "the bar is on the page");
		assert.equal(mem.get("wolfpack:chatbar:attached"), undefined);
		assert.equal(mem.get("wolfpack:chatbar:home-wolf"), undefined);
	});

	it("a home thread that shows up after an incomplete first load still gets attached", async () => {
		noHome = true;
		secondWolfDown = true;
		await mount("/kb");
		assert.equal(mem.get(ATTACHED_KEY), undefined, "no home thread yet and a list is missing: nothing decided");
		noHome = false;
		secondWolfDown = false;
		dataStore.clear();
		await act(async () => void fireOpen?.());
		await wait();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/home");
	});

	it("is on /chat/new and hidden on the pairing page", async () => {
		await mount("/chat/new", A);
		assert.ok(q('[data-testid="chat-bar"]'), "the new-chat page keeps the bar");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		await mount("/pair", A);
		assert.equal(q('[data-testid="chat-bar"]'), null, "no console to chat from before sign-in");
	});

	it("with the extras off the bar fetches no cards, reply peek or needs-you list", async () => {
		assert.equal(BAR_EXTRAS.cards || BAR_EXTRAS.peek || BAR_EXTRAS.badge, false);
		// The paged-ask sheet is the one extra that is on: it reads the thread's pending cards, so it is off here to check the rest.
		BAR_EXTRAS.ask = false;
		try {
			await mount("/kb", A);
			assert.ok(q('[data-testid="chat-bar"]'));
			assert.deepEqual(gets.filter((u) => /\/threads\/a(\?|$)|needs-you/.test(u)), []);
			assert.equal(q('[data-testid="chat-bar-card-surface"]')?.children.length ?? 0, 0);
			assert.equal(q('[data-testid="chat-bar-needs-you"]'), null);
		} finally {
			BAR_EXTRAS.ask = true;
		}
	});

	it("A thread attached while its page is open shows the bar once the owner leaves", async () => {
		let go: (u: string) => void = () => {};
		function Nav() {
			const r = React.useContext((await_ctx as any));
			go = (u) => (r as any).push(u);
			return null;
		}
		await mount("/wolf/w/thread/a", undefined, <><Nav /><AttachHere /></>);
		await click(q('[data-testid="test-attach"]'));
		assert.equal(q('[data-testid="chat-bar"]'), null, "hidden on its own page");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a", "kept across reloads");
		await act(async () => go("/kb"));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "open");
	});

	it("the chip row shows one badge per running sub-agent, and nothing when none run", async () => {
		kids = [{ id: "w/k1", title: "scout", agent: "worker", state: "running", parentThreadId: "w/a" }, { id: "w/k2", title: "coder", agent: "worker", state: "running", parentThreadId: "w/a" }, { id: "w/k3", title: "old", agent: "worker", state: "done", parentThreadId: "w/a" }];
		await mount("/kb", A);
		const chips = [...document.querySelectorAll('[data-testid="subagent-badge"]')];
		assert.deepEqual(chips.map((c) => c.getAttribute("title")), ["scout", "coder"]);
		assert.equal(chips[0]!.getAttribute("aria-label"), "scout, running");
		assert.ok(chips[0]!.closest('[data-testid="chat-bar"]'), "inside the bar surface");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		kids = [];
		await mount("/kb", A);
		assert.equal(q('[data-testid="subagent-badge"]'), null);
	});

	it("has no pop-out/dock button", async () => {
		await mount("/kb", A);
		assert.ok(q('[data-testid="chat-bar"]'));
		assert.equal(q('[data-testid="chat-bar-dock"]'), null);
		assert.equal(document.querySelector('[aria-label="Dock chat"]'), null);
	});

	it("landing on the attached thread's own page hides the bar (the page composer is the chat) without detaching it", async () => {
		let go: (u: string) => void = () => {};
		function Nav() {
			const r = React.useContext((await_ctx as any));
			go = (u) => (r as any).push(u);
			return null;
		}
		await mount("/kb", A, <Nav />);
		await type("kept");
		await act(async () => go("/wolf/w/thread/a"));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a", "still attached");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "kept");
		await act(async () => go("/graph"));
		await wait();
		assert.ok(q('[data-testid="chat-bar"]'), "floats again off the page");
	});

	it("a reload on the attached thread's own page leaves the page's draft alone", async () => {
		mem.set("wolfpack:draft:w:w/a", "typed on the page");
		await mount("/wolf/w/thread/a", A);
		assert.equal(q('[data-testid="chat-bar"]'), null);
		window.dispatchEvent(new dom.window.Event("pagehide"));
		await wait();
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "typed on the page", "no stale flush from the bar");
	});

	it("the switcher's Open thread page opens the thread page, where the chat docks into the page", async () => {
		function Path() {
			return <span data-testid="path">{usePathname()}</span>;
		}
		await mount("/kb", A, <Path />);
		await click(q('[data-testid="chat-bar-chip"]'));
		await click((q('[data-testid="den-thread"][aria-current="true"]')!.closest('[data-testid="den-thread-group"]')!.querySelector('[data-testid="den-thread-open"]') as HTMLElement));
		await wait();
		assert.equal(q('[data-testid="path"]')?.textContent, "/wolf/w/thread/a");
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a");
	});

	describe("on another thread's page the bar floats with a swap pill", () => {
		const swap = () => q('[data-testid="chat-bar-swap"]');

		it("shows 'Swap to <thread>' on a mismatch only; none on the attached page or a non-thread page", async () => {
			await mount("/wolf/w/thread/b", A);
			assert.equal(swap()?.getAttribute("aria-label"), "Swap to w/b");
			assert.equal(q('[data-testid="chat-bar-swap-wrap"]'), null, "the separate Swap pill is gone: the den button is the control");
			assert.equal(swap()?.getAttribute("data-swap"), "true");
			assert.equal(document.querySelectorAll('[data-testid="chat-bar"]').length, 1);
			await act(async () => root?.unmount());
			document.body.innerHTML = "";
			await mount("/kb", A);
			assert.equal(swap(), null, "no pill off thread pages");
			await act(async () => root?.unmount());
			document.body.innerHTML = "";
			await mount("/wolf/w/thread/a", A);
			assert.equal(swap(), null, "no pill on the attached thread's own page");
		});

		it("the bottom fade backdrop shows over a thread page's transcript only, not on the graph or other pages", async () => {
			const backdrop = () => q('[data-testid="chat-bar-backdrop"]');
			await mount("/wolf/w/thread/b", A);
			assert.notEqual(backdrop(), null, "fades the transcript on a thread page");
			for (const path of ["/graph", "/kb"]) {
				await act(async () => root?.unmount());
				document.body.innerHTML = "";
				await mount(path, A);
				assert.equal(backdrop(), null, `no fade on ${path}`);
			}
		});

		it("stays open over a thread page even when minimized elsewhere (the pill is the way to type there)", async () => {
			mem.set("wolfpack:chatbar:minimized", "1");
			await mount("/wolf/w/thread/b", A);
			assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "open");
			assert.ok(swap());
		});

		it("turns amber and says Answer when the page's thread waits on the owner (its ask sheet is hidden under the bar); choosing it swaps", async () => {
			bNeedsYou = true;
			await mount("/wolf/w/thread/b", A);
			assert.equal(swap()?.getAttribute("aria-label"), "Answer w/b");
			assert.equal(swap()?.getAttribute("data-needs-you"), "true");
			await click(swap());
			await wait();
			assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/b");
		});

		it("waits while a send's POST is in flight, so a failed send still has its composer to restore into", async () => {
			let release!: () => void;
			holdSubmit = new Promise<void>((r) => void (release = r));
			await mount("/wolf/w/thread/b", A);
			await type("hello");
			await submit();
			assert.equal(swap()?.hasAttribute("disabled"), true);
			await click(swap());
			assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a", "no swap while sending");
			release();
			await wait();
			assert.equal(swap()?.hasAttribute("disabled"), false);
		});

		it("choosing the pill attaches the page's thread: the bar steps aside for the page composer, drafts stay with their thread", async () => {
			await mount("/wolf/w/thread/b", A);
			await type("for a");
			await click(swap());
			await wait();
			assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/b", "attached to the page's thread");
			assert.equal(q('[data-testid="chat-bar"]'), null, "docked: only the page composer remains");
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "for a", "A's text stays with A");
			assert.equal(mem.get("wolfpack:draft:w:w/b"), undefined);
		});
	});

	it("an idle send POSTs reject; a busy send steers; Stop aborts", async () => {
		await mount("/kb", A);
		await type("hello");
		await submit();
		await wait();
		const sub = calls.find((c) => c.url.endsWith("/threads/a/submit"))!;
		assert.equal(sub.body.whenBusy, "reject");
		assert.equal(sub.body.input, "hello");
		assert.ok(q('[data-testid="chat-bar-working"]'), "working shown after send");
		calls = [];
		await type("more");
		await submit();
		await wait();
		assert.equal(calls[0]!.body.whenBusy, "steer");
		await type("");
		const stop = document.querySelector('button[aria-label="Stop"]') as HTMLElement;
		assert.ok(stop);
		await submit();
		await wait();
		assert.ok(calls.some((c) => c.url.endsWith("/threads/a/abort")));
	});

	it("minimized state persists", async () => {
		await mount("/kb", A);
		await click(q('[data-testid="chat-bar-minimize"]'));
		assert.equal(mem.get("wolfpack:chatbar:minimized"), "1");
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized");
	});
});

describe("ChatBar behaviours", () => {
	it("a failed send drops the optimistic working state and puts the text back, merged", async () => {
		const orig = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" ? new Response("no", { status: 500 }) : orig(input, init))) as typeof fetch;
		try {
			await mount("/kb", A);
			await type("lost?");
			await submit();
			await wait();
			assert.equal(q('[data-testid="chat-bar-working"]'), null);
			assert.equal(ta().value, "lost?");
		} finally {
			globalThis.fetch = orig;
		}
	});

	it("Cmd+J answers (and claims the key) when the bar or its icon is on the page", async () => {
		const press = (name: string) => {
			let prevented = false;
			window.dispatchEvent(new dom.window.CustomEvent(name, { detail: { event: { preventDefault: () => void (prevented = true) } } }));
			return prevented;
		};
		await mount("/kb", A);
		await click(q('[data-testid="chat-bar-minimize"]'));
		assert.equal(press("wolfpack:kbd-focus-chat-bar"), true);
		await wait();
		assert.equal(mem.get("wolfpack:chatbar:minimized"), undefined, "expanded again");
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		mem.clear();
		noHome = true;
		await mount("/kb"); // nothing attached and no home thread to attach: only the icon, Cmd+J does nothing
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized");
		assert.equal(press("wolfpack:kbd-focus-chat-bar"), true, "Cmd+J focuses the icon (Enter opens it)");
	});

	it("Cmd+J on the popped-out thread's own page focuses the page composer", async () => {
		let focused = false;
		const page = (
			<form data-testid="composer">
				<textarea ref={(el) => { if (el) el.focus = () => void (focused = true); }} />
			</form>
		);
		await mount("/wolf/w/thread/a", undefined, <>{page}<AttachHere /></>);
		await click(q('[data-testid="test-attach"]')); // attached while still on its own page
		let prevented = false;
		window.dispatchEvent(new dom.window.CustomEvent("wolfpack:kbd-focus-chat-bar", { detail: { event: { preventDefault: () => void (prevented = true) } } }));
		assert.ok(focused && prevented);
	});

	it("a live archive of the popped-out thread docks it", async () => {
		await mount("/kb", A);
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a");
		archived = true;
		await emit("needs-you-changed", { wolf: "w", threadId: "w/a", status: "idle" });
		await wait();
		assert.equal(mem.get(ATTACHED_KEY), undefined);
	});

	it("a thread-updated that closes the popped-out thread docks the bar at once, without waiting for the list; another thread closing does not", async () => {
		await mount("/kb", A);
		await emit("thread-updated", { wolf: "w", thread: { id: "w/b", closed: true } });
		await emit("thread-updated", { wolf: "other", thread: { id: "w/a", closed: true } });
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a");
		assert.ok(ta(), "still has its composer");
		await emit("thread-updated", { wolf: "w", thread: { id: "w/a", closed: true } });
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		assert.equal(ta(), null);
	});
});

describe("a close while the popped-out thread's turn runs", () => {
	it("keeps the bar with the closed notice and a working Stop, and docks it once the turn settles", async () => {
		status = "busy";
		await mount("/kb", A);
		await emit("thread-updated", { wolf: "w", thread: { id: "w/a", closed: true, closedReason: "This feature has graduated." } });
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a", "still attached");
		assert.equal(ta(), null, "no composer");
		assert.match(q('[data-testid="chat-bar-closed"]')!.textContent ?? "", /This feature has graduated\./);
		calls = [];
		await click(q('[data-testid="chat-bar-closed-stop"]'));
		assert.ok(calls.some((c) => c.url.endsWith("/threads/a/abort")), "Stop reaches the abort route");
		status = "idle";
		await emit("needs-you-changed", { wolf: "w", threadId: "w/a", status: "idle" });
		await wait();
		assert.equal(mem.get(ATTACHED_KEY), undefined, "docked after the turn settled");
		assert.equal(q('[data-testid="chat-bar-closed"]'), null);
	});
});

describe("real keydown through KeyboardShortcuts", () => {
	const keydown = (init: object, target?: HTMLElement) =>
		act(async () => {
			const ev = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), init);
			(target ?? window).dispatchEvent(ev);
			return ev;
		});
	async function mountWithKeys(start: string) {
		mem.set(ATTACHED_KEY, JSON.stringify(A));
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<FakeNav start={start}>
					<>
						<ServerEventsProvider connect={fakeSource}>
							<AttachedThreadProvider>
								<ChatBar />
								<input data-testid="other" />
								<KeyboardShortcuts />
							</AttachedThreadProvider>
						</ServerEventsProvider>
					</>
				</FakeNav>,
			);
		});
		await wait();
	}
	it("Cmd+J un-minimizes and focuses; Cmd+Shift+J opens the switcher; a bare j in another input is ignored", async () => {
		await mountWithKeys("/kb");
		await click(q('[data-testid="chat-bar-minimize"]'));
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized");
		const bare = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "j" });
		await act(async () => void q('[data-testid="other"]')!.dispatchEvent(bare));
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "minimized", "bare j types, nothing happens");
		const ev = await keydown({ key: "j", metaKey: true });
		assert.equal(ev.defaultPrevented, true, "the bar claimed Cmd+J");
		await wait();
		assert.equal(q('[data-testid="chat-bar"]')?.getAttribute("data-state"), "open");
		await keydown({ key: "j", metaKey: true, shiftKey: true });
		await wait();
		assert.equal(q('[data-testid="den-sheet"]')?.getAttribute("data-layout"), "inline");
	});
	it("Cmd+J is left to the browser with nothing attached", async () => {
		await mountWithKeys("/kb");
		mem.clear();
		await act(async () => root?.unmount());
		document.body.innerHTML = "";
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => {
			root!.render(
				<FakeNav start="/kb">
					<>
						<KeyboardShortcuts />
					</>
				</FakeNav>,
			);
		});
		const ev = await keydown({ key: "j", metaKey: true });
		assert.equal(ev.defaultPrevented, false);
	});
});

describe("submitToThread", () => {
	it("retries a 409 on an optimistic idle send as a steer", async () => {
		const seen: string[] = [];
		const f = (async (_u: string, init: RequestInit) => {
			const b = JSON.parse(String(init.body));
			seen.push(b.whenBusy);
			return new Response("{}", { status: b.whenBusy === "reject" ? 409 : 200 });
		}) as unknown as typeof fetch;
		assert.equal(await submitToThread({ wolf: "w", slug: "a" }, "x", false, [], f), true);
		assert.deepEqual(seen, ["reject", "steer"]);
	});
});
void useAttachedThread;
