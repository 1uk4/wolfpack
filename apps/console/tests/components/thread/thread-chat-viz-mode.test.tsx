/**
 * Visualization mode on the thread page (real ThreadChat + ChatBar + AttachedThreadProvider): a button shows only while a view is
 * open; on, the transcript and page composer hide, the viewer fills the width and the floating chat bar shows; the choice is kept
 * per thread; the view closing leaves the mode; a draft typed in the bar is in the page composer after leaving.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } }),
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
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

// ---- fake mic + Deepgram socket (the bar's dictation) ----
class FakeWS {
	static OPEN = 1;
	static CONNECTING = 0;
	static last: FakeWS | null = null;
	readyState = 0;
	private ls = new Map<string, ((ev: unknown) => void)[]>();
	constructor() {
		FakeWS.last = this;
	}
	addEventListener(t: string, f: (ev: unknown) => void) {
		this.ls.set(t, [...(this.ls.get(t) ?? []), f]);
	}
	send() {}
	close() {
		this.readyState = 3;
	}
	emit(t: string, ev: unknown = {}) {
		for (const f of this.ls.get(t) ?? []) f(ev);
	}
	open() {
		this.readyState = 1;
		this.emit("open");
	}
	final(text: string) {
		this.emit("message", { data: JSON.stringify({ type: "Results", is_final: true, channel: { alternatives: [{ transcript: text }] } }) });
	}
}
class FakeNode {
	port: { onmessage: unknown } = { onmessage: null };
	connect() {}
	disconnect() {}
}
class FakeCtx {
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() {
		return new FakeNode();
	}
	async resume() {}
	async suspend() {}
}
Object.assign(globalThis, { WebSocket: FakeWS, AudioContext: FakeCtx, AudioWorkletNode: FakeNode });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } } });

const { MockConsoleClient, FIXTURE_THREAD } = await import("@wolfpack/client");
const { cardsOfThread, threadMessagesToNative } = await import("../../../src/core/index.ts");
const { ThreadChat } = await import("../../../components/thread/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../../../components/memory/memory-events.tsx");
const { FakeNav } = await import("../../helpers/fake-nav.tsx");
const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { dataStore } = await import("../../../src/core/data-store.ts");
const { AttachedThreadProvider, useAttachedThread } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar } = await import("../../../components/chat-bar/chat-bar.tsx");
const { registerViewRenderer } = await import("../../../components/viewer/registry.tsx");
const vs = await import("../../../components/viewer/viewer-store.ts");
const pinStore = await import("../../../components/thread/pin-store.ts");
const { ATTACHED_KEY, BAR_EXTRAS } = await import("../../../src/core/thread/chat-bar.ts");
const { setVizActive, vizKey } = await import("../../../components/viewer/viz-mode.ts");

registerViewRenderer("kb", () => <div>kb body</div>);

/** Lets a test unmount only the thread page (the bar and providers stay), like navigating away. */
let hideChat: (() => void) | null = null;
function Gate({ children }: { children: React.ReactNode }) {
	const [shown, setShown] = React.useState(true);
	hideChat = () => setShown(false);
	return shown ? <>{children}</> : null;
}

const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });
const realFetch = globalThis.fetch;
let root: Root | null = null;
const TID = FIXTURE_THREAD.id;
const VIZ = vizKey("1uk4", TID);
const DRAFT = `wolfpack:draft:1uk4:${TID}`;

const th = (id: string, status = "idle") => ({ id, title: id, kind: "feature", status });
let homeStatus = "idle"; // the status the thread list gives this page's thread (needs-you: a pending ask)
let attachApi: ReturnType<typeof useAttachedThread> = null;
function Probe() {
	attachApi = useAttachedThread();
	return null;
}
let lists = false; // the wolf and thread lists (the badge and switcher need them); off, they 404 like the other tests
const barFetch = (async (input: RequestInfo | URL) => {
	const url = String(input);
	if (url.includes("/api/stt/token")) return new Response(JSON.stringify({ token: "tok" }), { status: 200 });
	if (lists && url === "/api/wolves") return Response.json({ wolves: [{ name: "1uk4" }] });
	if (lists && url === "/api/wolves/1uk4/threads") return Response.json({ threads: [th("1uk4/other"), th("1uk4/waiting", "needs-you"), th("1uk4/home", homeStatus)] });
	if (lists && url === "/api/needs-you") return Response.json({ items: [] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

const PAGED_ASK = { tool: "ask", paged: true, fields: [{ id: "q1", kind: "single", label: "Pick one", options: [{ label: "Alpha", value: "a" }, { label: "Beta", value: "b" }] }], steps: [{ title: "First", fields: ["q1"] }] };

async function mount(opts: { chat?: boolean; start?: string; ask?: boolean } = {}) {
	globalThis.fetch = barFetch;
	const client = new MockConsoleClient({ delayMs: 0, script: [{ kind: "text", text: "ok" }] });
	const detail = await client.getThread(TID);
	if (opts.ask) {
		const asked = { id: "entry-ask", role: "assistant" as const, text: "", at: new Date().toISOString(), tools: [{ callId: "call-ask", name: "ask", args: { question: "q" }, result: "The operator was asked.", card: PAGED_ASK }] };
		detail.messages = [asked, ...detail.messages] as never;
		(detail as { pendingCards?: unknown[] }).pendingCards = [{ callId: "call-ask", threadId: TID, card: PAGED_ASK, raisedAt: new Date().toISOString() }];
	}
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<FakeNav start={opts.start ?? "/wolf/1uk4/thread/home"}>
				<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
					<AttachedThreadProvider>
						<ChatBar />
						<Probe />
						<MemoryEventsProvider connect={inertSource}>
							<Gate>
								{opts.chat === false ? null : <ThreadChat wolf="1uk4" slug="home" threadId={TID} title="Home" initialMessages={threadMessagesToNative(detail.messages)} initialCards={cardsOfThread(detail)} />}
							</Gate>
						</MemoryEventsProvider>
					</AttachedThreadProvider>
				</ServerEventsProvider>
			</FakeNav>,
		);
	});
	await settle(60);
}

const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const click = (el: Element) => act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 })));
const typeIn = (el: HTMLTextAreaElement, v: string) =>
	act(async () => {
		el.value = v;
		const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"))!;
		(el as any)[k].onChange({ target: el, currentTarget: el });
	});
const openKb = () => act(async () => vs.openView("1uk4", TID, { kind: "kb", id: "e1" }));
const mainHidden = () => (q('[data-testid="thread-main"]')!.getAttribute("class") ?? "").split(" ").includes("hidden");

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	homeStatus = "idle";
	dataStore.clear(); // the thread list goes through the client store: the next test must not read this one's list
	await act(async () => root?.unmount());
	root = null;
	setVizActive(null);
	vs.resetViewerCache();
	store.clear();
	document.body.innerHTML = "";
});

describe("thread visualization mode", () => {
	it("the button is hidden with no open view and shown once a view is open", async () => {
		await mount();
		assert.equal(q('[data-testid="viz-toggle"]'), null);
		await openKb();
		assert.ok(q('[data-testid="viz-toggle"]'));
	});

	it("turning it on hides the transcript and page composer, fills the width and shows the chat bar; turning it off restores them", async () => {
		await mount();
		await openKb();
		assert.equal(q('[data-testid="chat-bar"] [data-testid="composer"]'), null, "no floating composer on the thread's own page normally (only the icon)");
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		assert.equal(mainHidden(), true);
		assert.equal(q('[data-testid="viewer-panel"]')!.getAttribute("data-fill"), "true");
		assert.ok(q('[data-testid="chat-bar"]'), "bar shows");
		assert.equal(q('[data-testid="thread-main"] [data-testid="composer"]'), null, "no page composer");
		assert.ok(q('[data-testid="chat-bar"] [data-testid="composer"]'), "the bar has the input");
		assert.match(q('[data-testid="viewer-body"]')!.getAttribute("style") ?? "", /padding-bottom:\s*calc\(var\(--chat-bar-h, 0px\) \+ 1rem\)/);
		assert.notEqual(document.documentElement.style.getPropertyValue("--chat-bar-h"), "", "the bar publishes its height");
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		assert.equal(mainHidden(), false);
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(document.documentElement.style.getPropertyValue("--chat-bar-h"), "", "cleared when the bar hides");
	});

	it("reading a thread's choice deletes the old wolf-prefixed key without migrating it", async () => {
		const OLD = `wolfpack:viz:1uk4:${TID}`;
		store.set(OLD, "1");
		await mount();
		assert.equal(store.has(OLD), false);
		assert.equal(mainHidden(), false);
	});

	it("the pinned strip is hidden with the chat in visualization mode and back when it is off", async () => {
		pinStore.pin(TID, { kind: "kb", id: "e1", title: "Entry", pinnedBy: "owner" });
		await mount();
		await openKb();
		assert.ok(q('[data-testid="thread-main"] [data-testid="pinned-strip"]'), "strip lives in the chat column");
		assert.equal(mainHidden(), false);
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		assert.equal(mainHidden(), true, "the strip's container is hidden with the transcript");
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		assert.equal(mainHidden(), false);
		assert.ok(q('[data-testid="thread-main"] [data-testid="pinned-strip"]'));
	});

	it("on the phone the pinned strip is a flow sibling above the transcript scroller; from md up it stays an overlay", async () => {
		pinStore.pin(TID, { kind: "kb", id: "e1", title: "Entry", pinnedBy: "owner" });
		await mount();
		const tint = q('[data-testid="thread-tint"]')!;
		const col = q('[data-testid="pinned-column"]')!;
		assert.equal(col.parentElement, tint);
		assert.equal(tint.firstElementChild, col, "the column comes first on phones (flex-col order)");
		assert.match(tint.getAttribute("class") ?? "", /max-md:flex-col/);
		const cls = (col.getAttribute("class") ?? "").split(" ");
		assert.ok(cls.includes("max-md:relative"), "in flow on phones");
		assert.ok(cls.includes("md:absolute"), "desktop keeps the overlay");
		assert.ok(!cls.includes("absolute"), "no unconditional absolute");
		assert.ok(cls.includes("max-md:[--pin-max:40%]"), "capped at 40% of the area on phones");
		assert.ok(cls.includes("md:[--pin-max:var(--pin-desk)]"), "desktop keeps the dock-based cap");
		assert.match(q('[data-testid="transcript-column"]')!.getAttribute("class") ?? "", /md:pt-\[var\(--pin-pt\)\]/);
	});

	it("the choice is kept per thread across a reload", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		assert.equal(store.get(VIZ), "1");
		await act(async () => root?.unmount());
		root = null;
		setVizActive(null);
		document.body.innerHTML = "";
		await mount();
		await settle(60);
		assert.equal(mainHidden(), true);
	});

	it("arriving on ?view=frame:<path> turns the mode on, a work or kb ?view= key leaves it off, and leaving the mode is not undone", async () => {
		await mount({ start: "/wolf/1uk4/thread/home?view=frame%3Aa.html" });
		await settle(60);
		assert.equal(store.get(VIZ), "1");
		assert.equal(mainHidden(), true);
		await act(async () => vs.closeViewer("1uk4", TID));
		await settle(60);
		assert.equal(store.get(VIZ), undefined, "later renders do not re-enable it");
		assert.equal(mainHidden(), false);
		await act(async () => root?.unmount());
		root = null;
		setVizActive(null);
		vs.resetViewerCache();
		document.body.innerHTML = "";
		for (const key of ["work%3Ax", "kb%3Ae1"]) {
			await mount({ start: `/wolf/1uk4/thread/home?view=${key}` });
			await settle(60);
			assert.equal(store.get(VIZ), undefined, key);
			assert.equal(mainHidden(), false, key);
			await act(async () => root?.unmount());
			root = null;
			setVizActive(null);
			vs.resetViewerCache();
			document.body.innerHTML = "";
		}
	});

	it("the open view closing leaves the mode and shows the transcript again", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		await act(async () => vs.closeViewer("1uk4", TID));
		await settle(60);
		assert.equal(mainHidden(), false);
		assert.equal(store.get(VIZ), undefined);
		assert.equal(q('[data-testid="viz-toggle"]'), null);
	});

	it("leaving the page while the mode is on ends the mode but keeps the thread attached (the bar is always on screen now)", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(60);
		assert.ok(q('[data-testid="chat-bar"]'));
		await act(async () => hideChat!());
		await settle(60);
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.ok(store.get(ATTACHED_KEY), "still attached");
	});

	it("a draft typed in the bar during the mode is in the page composer after leaving it", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(80);
		await typeIn(q('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement, "half a thought");
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(80);
		const page = q('[data-testid="thread-main"] [data-testid="composer"] textarea') as HTMLTextAreaElement;
		assert.equal(page.value, "half a thought");
		assert.equal(store.get(DRAFT), "half a thought");
	});

	it("a stored choice survives a reload where the viewer state hydrates after the first effects, and the mode is on once the view appears", async () => {
		store.set(VIZ, "1");
		await mount(); // no view yet: the viewer store has not hydrated
		await settle(60);
		assert.equal(store.get(VIZ), "1", "an unhydrated viewer is not a closing view");
		assert.equal(mainHidden(), false);
		await openKb(); // the view arrives late
		await settle(60);
		assert.equal(mainHidden(), true);
		assert.equal(store.get(VIZ), "1");
	});

	describe("with the bar's extras on", () => {
		const saved = { ...BAR_EXTRAS };
		beforeEach(() => void ((lists = true), Object.assign(BAR_EXTRAS, { badge: true, switcher: true })));
		afterEach(() => void ((lists = false), Object.assign(BAR_EXTRAS, saved)));

		it("a bar attached to another thread keeps its needs-you badge and switcher while viz is on for this one", async () => {
			store.set(ATTACHED_KEY, JSON.stringify({ wolf: "1uk4", slug: "other", threadId: "1uk4/other" }));
			await mount({ chat: false, start: "/kb" }); // a page that is not a thread page, so the bar shows for its own target
			await act(async () => setVizActive({ wolf: "1uk4", threadId: TID }));
			await settle(80);
			assert.ok(q('[data-testid="chat-bar"]'), "the bar shows for its own target");
			assert.equal(q('[data-testid="chat-bar-needs-you"]')?.getAttribute("data-thread"), "1uk4/waiting");
			await click(q('[data-testid="chat-bar-chip"]')!);
			assert.ok(q('[data-testid="chat-bar-switcher"]'), "the switcher opens");
		});
	});

	it("dictating from the bar in the mode keeps the bar up and un-docked, and the dictated draft is in the page composer after leaving", async () => {
		await mount();
		await openKb();
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(80);
		await click(q('[data-testid="chat-bar"] [data-testid="dictation-toggle"]')!);
		await settle(40);
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		await act(async () => ws.final("spoken in viz"));
		await act(async () => ws.emit("close", { code: 1000 }));
		await settle(80);
		assert.ok(q('[data-testid="chat-bar"]'), "the bar is still showing");
		assert.ok(store.get(ATTACHED_KEY), "not docked");
		assert.equal(mainHidden(), true);
		await click(q('[data-testid="viz-toggle"]')!);
		await settle(80);
		const page = q('[data-testid="thread-main"] [data-testid="composer"] textarea') as HTMLTextAreaElement;
		assert.equal(page.value, "spoken in viz");
	});
});

describe("automatic docking: one composer on a thread page", () => {
	const OTHER = { wolf: "1uk4", slug: "other", threadId: "1uk4/other" };
	const composers = () => document.querySelectorAll('[data-testid="composer"]').length;
	beforeEach(() => void (lists = true));
	afterEach(() => void (lists = false));

	it("attached == the page's thread: the page composer is the docked chat, the only composer, no bar and no pill", async () => {
		store.set(ATTACHED_KEY, JSON.stringify({ wolf: "1uk4", slug: "home", threadId: TID }));
		await mount();
		assert.equal(composers(), 1);
		assert.ok(q('[data-testid="thread-main"] [data-testid="composer"]'), "in the thread's chat panel");
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(q('[data-testid="chat-bar-swap"]'), null);
	});

	it("another thread attached: the bar floats with a swap pill and the page composer steps aside, so there is one composer", async () => {
		store.set(ATTACHED_KEY, JSON.stringify(OTHER));
		await mount();
		assert.equal(composers(), 1);
		assert.ok(q('[data-testid="chat-bar"] [data-testid="composer"]'), "the bar's composer is the one");
		assert.equal(q('[data-testid="thread-composer-card"]'), null);
		assert.equal(q('[data-testid="chat-bar-swap"]')!.getAttribute("aria-label"), "Swap to 1uk4/home");
	});

	it("swapping attaches the page's thread and docks: still one composer, now the page's; the other thread's draft stays with it", async () => {
		store.set(ATTACHED_KEY, JSON.stringify(OTHER));
		await mount();
		await typeIn(q('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement, "for other");
		await click(q('[data-testid="chat-bar-swap"]')!);
		await settle(80);
		assert.equal(JSON.parse(store.get(ATTACHED_KEY)!).threadId, TID);
		assert.equal(composers(), 1);
		assert.ok(q('[data-testid="thread-main"] [data-testid="composer"]'), "docked into the page");
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal((q('[data-testid="thread-main"] textarea') as HTMLTextAreaElement).value, "", "the page's own draft is its own");
		assert.equal(store.get("wolfpack:draft:1uk4:1uk4/other"), "for other", "the other thread's draft stays with it");
	});

	it("the page's thread waits on the owner: its ask sheet is hidden under the bar, so the pill turns amber (Answer); swapping docks and shows the sheet", async () => {
		store.set(ATTACHED_KEY, JSON.stringify(OTHER));
		homeStatus = "needs-you";
		await mount({ ask: true });
		assert.equal(q('[data-testid="thread-main"] [data-testid="ask-sheet"]'), null, "hidden while the bar floats over the page");
		const pill = q('[data-testid="chat-bar-swap"]')!;
		assert.equal(pill.getAttribute("data-needs-you"), "true");
		assert.equal(pill.getAttribute("aria-label"), "Answer 1uk4/home");
		await click(pill);
		await settle(80);
		assert.equal(JSON.parse(store.get(ATTACHED_KEY)!).threadId, TID);
		assert.ok(q('[data-testid="thread-main"] [data-testid="ask-sheet"]'), "the questionnaire shows in the docked page");
		assert.equal(composers(), 1);
	});

	it("the page holds a pending ask while the thread list still says idle: the pill is amber (Answer) all the same", async () => {
		store.set(ATTACHED_KEY, JSON.stringify(OTHER));
		await mount({ ask: true }); // homeStatus stays idle: a stale list
		const pill = q('[data-testid="chat-bar-swap"]')!;
		assert.equal(pill.getAttribute("data-needs-you"), "true");
		assert.equal(pill.getAttribute("aria-label"), "Answer 1uk4/home");
	});

	it("text typed in the page composer inside the debounce window survives the chat moving to another thread and back", async () => {
		store.set(ATTACHED_KEY, JSON.stringify({ wolf: "1uk4", slug: "home", threadId: TID }));
		await mount();
		await typeIn(q('[data-testid="thread-main"] textarea') as HTMLTextAreaElement, "typed just before");
		await act(async () => attachApi!.attach(OTHER)); // well inside the 300ms debounce
		await settle(450); // the timer fires with the bar owning the page's input
		assert.equal(store.get(DRAFT), "typed just before", "flushed before ownership moved");
		await click(q('[data-testid="chat-bar-swap"]')!);
		await settle(80);
		assert.equal((q('[data-testid="thread-main"] textarea') as HTMLTextAreaElement).value, "typed just before");
	});

	it("a deeper path under the thread page has no pill, so it must not hide the page composer either", async () => {
		store.set(ATTACHED_KEY, JSON.stringify(OTHER));
		await mount({ start: "/wolf/1uk4/thread/home/files" });
		assert.equal(q('[data-testid="chat-bar-swap"]'), null);
		assert.ok(q('[data-testid="thread-composer-card"]'), "the page composer stays");
	});
});
