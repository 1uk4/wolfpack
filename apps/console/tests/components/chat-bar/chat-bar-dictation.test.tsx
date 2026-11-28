/**
 * The floating chat's mic (real mount, fake Deepgram socket + mic): the run lives in ChatBar so it keeps listening while the
 * owner browses; docking by any route finishes it first so the words land in the draft; Cmd+D goes to the right input.
 */
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
	getComputedStyle: () => ({ animationName: "none" }),
});
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });
// linkedom does not track focus: record it so document.activeElement answers like a browser.
let focused: Element | null = null;
(dom.window.HTMLElement.prototype as any).focus = function () { focused = this; };
Object.defineProperty(dom.document, "activeElement", { get: () => focused, configurable: true });

// ---- fake mic + Deepgram socket ----
class FakeWS {
	static OPEN = 1;
	static CONNECTING = 0;
	static last: FakeWS | null = null;
	static count = 0;
	readyState = 0;
	private ls = new Map<string, ((ev: unknown) => void)[]>();
	constructor() {
		FakeWS.last = this;
		FakeWS.count++;
	}
	addEventListener(t: string, f: (ev: unknown) => void) {
		this.ls.set(t, [...(this.ls.get(t) ?? []), f]);
	}
	sent: unknown[] = [];
	send(d: unknown) {
		this.sent.push(d);
	}
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
	async resume() {
		this.state = "running";
	}
	async suspend() {
		this.state = "suspended";
	}
}
Object.assign(globalThis, { WebSocket: FakeWS, AudioContext: FakeCtx, AudioWorkletNode: FakeNode });
Object.defineProperty(globalThis, "navigator", {
	configurable: true,
	value: { userAgent: "test", mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => void stops++ }] }) } },
});

const { usePathname } = await import("next/navigation");
const { AppRouterContext: navCtx } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ServerEventsProvider } = await import("../../../components/shell/server-events.tsx");
const { FakeNav, navLog } = await import("../../helpers/fake-nav.tsx");
const { useThreadDictation } = await import("../../../components/composer/use-thread-dictation.ts");
const { useComposerDraft, appendToDraft, draftKey, writeDraft, useRereadDraftWhenShown } = await import("../../../lib/composer-draft.ts");
const { AttachedThreadProvider, useAttachedThread } = await import("../../../components/chat-bar/attached-thread.tsx");
const { ChatBar } = await import("../../../components/chat-bar/chat-bar.tsx");
const { useDictation, DictationBar, joinDictation, useBarShown } = await import("../../../components/composer/dictation.tsx");
const { setDockSlot } = await import("../../../components/chat-bar/dock-slot.ts");
/** The empty box the attached thread's page leaves for the docked bar (thread-chat.tsx). */
const DockSlot = () => <div ref={setDockSlot} data-testid="thread-dock-slot" />;
const { ATTACHED_KEY } = await import("../../../src/core/thread/chat-bar.ts");
const { dataStore } = await import("../../../src/core/data-store.ts");

let posts: string[] = [];
let pagedAsk = false;
let requiredAsk = false;
let stops = 0;
let tokenFetches = 0;
let keylessToken = false;
let busyA = false;
const realFetch = globalThis.fetch;
const fakeSource = () => ({ close() {}, onOpen() {}, onEvent() {} });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url = String(input);
	if (init?.method === "POST") {
		posts.push(url);
		return new Response("{}", { status: 200 });
	}
	if (url.includes("/api/stt/token")) tokenFetches++;
	if (url.includes("/api/stt/token")) return keylessToken ? new Response(JSON.stringify({ message: "add a Deepgram key" }), { status: 503 }) : new Response(JSON.stringify({ token: "tok" }), { status: 200 });
	if (url === "/api/wolves") return Response.json({ wolves: [{ name: "w" }] });
	if (pagedAsk && /^\/api\/wolves\/w\/threads\/a\?/.test(url)) return Response.json({ messages: [], pendingCards: [{ callId: "p1", threadId: "w/a", raisedAt: "2026-11-09T00:00:00Z", card: { tool: "ask", paged: true, fields: [{ id: "q1", kind: "free-text", label: "Why", ...(requiredAsk ? {} : { optional: true }) }], steps: [{ fields: ["q1"] }] } }] });
	if (url === "/api/wolves/w/threads") return Response.json({ threads: [{ id: "w/a", title: "w/a", kind: "feature", status: busyA ? "busy" : "idle" }, { id: "w/b", title: "w/b", kind: "feature", status: "idle" }, { id: "w/c", title: "w/c", kind: "feature", status: "idle" }] });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

/** A page composer as the thread page / new-session build it: the real hook (kind "page") beside a composer textarea. */
function PageComposer() {
	const [text, setText] = React.useState("");
	const d = useDictation({ append: (t) => setText((c) => joinDictation(c, t)) });
	return (
		<form data-testid="composer">
			<textarea data-testid="page-ta" value={text} onChange={(e) => setText(e.target.value)} />
			<div data-testid="page-dictation"><DictationBar dictation={d} /></div>
		</form>
	);
}

/** The composer only on thread pages, as in the app. */
function PageComposerOnThreads() {
	return usePathname()?.startsWith("/wolf/") ? <PageComposer /> : null;
}

let root: Root | null = null;
let go: (u: string) => void = () => {};
function Nav() {
	const r = React.useContext(navCtx as any);
	go = (u) => (r as any).push(u);
	return <span data-testid="path">{usePathname()}</span>;
}
const wait = (ms = 40) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
async function mount(start: string, stored: object | null, extra?: React.ReactNode) {
	if (stored) mem.set(ATTACHED_KEY, JSON.stringify(stored));
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
							<Nav />
							{extra}
						</AttachedThreadProvider>
					</ServerEventsProvider>
				</>
			</FakeNav>,
		);
	});
	await wait(80);
}
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const barTa = () => q('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement | null;
const pageTa = () => q('[data-testid="page-ta"]') as HTMLTextAreaElement;
const fire = (el: Element, name: string, init: object = {}) =>
	act(async () => void el.dispatchEvent(Object.assign(new dom.window.Event(name, { bubbles: true, cancelable: true }), init)));
const barToggle = () => q('[data-testid="chat-bar"] [data-testid="dictation-toggle"]')!;
const key = () => act(async () => void window.dispatchEvent(new dom.window.CustomEvent("wolfpack:kbd-toggle-dictation")));
const A = { wolf: "w", slug: "a", threadId: "w/a" };

/** After the run is recording: deliver a final, then the socket closes (the run ends and its transcript flushes). */
async function say(text: string) {
	const ws = FakeWS.last!;
	await act(async () => ws.open());
	await act(async () => ws.final(text));
	return ws;
}
const endRun = (ws: FakeWS) => act(async () => ws.emit("close", { code: 1000 }));

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	mem.clear();
	posts = [];
	pagedAsk = false;
	requiredAsk = false;
	FakeWS.last = null;
	FakeWS.count = 0;
	stops = 0;
	tokenFetches = 0;
	keylessToken = false;
	busyA = false;
	dataStore.clear(); // the thread list is cached client-side: the next test must not read this one's
	focused = null;
});
after(() => void (globalThis.fetch = realFetch));

describe("floating chat dictation", () => {
	it("keeps listening across a page change and the transcript lands in the floating chat's input, unsent", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("hello from the graph");
		await act(async () => go("/graph"));
		await wait();
		assert.ok(q('[data-testid="chat-bar-listening"]') ?? q('[data-testid="chat-bar"] [data-testid="dictation-toggle"]'), "bar still there");
		assert.equal(FakeWS.count, 1, "no second run started");
		await fire(barToggle(), "click", { detail: 1 }); // Stop
		await endRun(ws);
		await wait();
		assert.equal(barTa()!.value, "hello from the graph");
		await wait(400); // the draft write is debounced
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "hello from the graph");
		assert.deepEqual(posts, []);
	});

	it("dictating while a question is open fills the inline composer, not the hidden bar composer, and Send binds it to the question", async () => {
		pagedAsk = true;
		await mount("/kb", A);
		await wait();
		await fire(q('[data-testid="ask-free"], [data-testid="ask-other"]')!, "click");
		assert.match(q('[data-testid="answering-chip"]')!.textContent!, /Replying to: Why/);
		assert.equal(q('[data-testid="ask-inline-composer"] [data-testid="dictation-toggle"]') !== null, true); // the Dictate row is in the sheet
		await fire(q('[data-testid="ask-inline-composer"] [data-testid="dictation-toggle"]')!, "click", { detail: 1 });
		await wait();
		const ws = await say("because of dictation");
		await endRun(ws);
		await wait();
		assert.equal(barTa()!.getAttribute("value") ?? (barTa() as any)[Object.keys(barTa()!).find((k) => k.startsWith("__reactProps$"))!].value, "because of dictation");
		assert.equal(q('[data-testid="ask-inline-composer"] textarea') === barTa(), true); // the only textarea in the bar is the inline one
		await fire(q('[data-testid="chat-bar"] form')!, "submit");
		await wait();
		assert.deepEqual(posts.filter((u) => /\/(submit|questions\/q1\/text)$/.test(u)), ["/api/wolves/w/threads/a/cards/p1/questions/q1/text"]);
	});

	it("dictating while the ask card's note composer is open fills the note, not the hidden draft, and Submit sends it with the answers", async () => {
		pagedAsk = true;
		await mount("/kb", A);
		await wait();
		const noteTa = () => { const all = document.querySelectorAll('[data-testid="chat-bar"] textarea'); return all[all.length - 1] as HTMLTextAreaElement; }; // the composer sits below the sheet
		assert.equal(q('[data-testid="ask-armed-live"]') !== null, true, "note mode");
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("note by voice");
		await endRun(ws);
		await wait();
		const val = () => (noteTa() as any)[Object.keys(noteTa()).find((k) => k.startsWith("__reactProps$"))!].value;
		assert.equal(val(), "note by voice");
		await wait(400);
		assert.equal(mem.get("wolfpack:draft:w:w/a") ?? "", "", "the normal draft stays empty");
		await fire(q('[data-testid="chat-bar"] form')!, "submit");
		await wait();
		assert.ok(posts.find((u) => u.endsWith("/cards/p1/submit")), "the card was submitted");
		assert.equal(posts.some((u) => u.endsWith("/threads/a/submit")), false, "no separate chat message");
		assert.equal(mem.get("wolfpack:draft:w:w/a") ?? "", "");
	});

	it("the bottom note box sends its note once with required questions unanswered (Send anyway), leaving no draft behind", async () => {
		pagedAsk = true;
		requiredAsk = true;
		await mount("/kb", A);
		await wait();
		const note = () => { const all = document.querySelectorAll('[data-testid="chat-bar"] textarea'); return all[all.length - 1] as HTMLTextAreaElement; };
		const props = (el: Element) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!];
		const submit = () => fire(q('[data-testid="chat-bar"] form[data-testid="composer"]')!, "submit");
		await act(async () => void props(note()).onChange({ target: { value: "context only" } }));
		await submit(); // arms
		assert.equal(posts.filter((u) => u.endsWith("/threads/a/submit")).length, 0);
		await submit();
		await wait(400);
		assert.equal(posts.filter((u) => u.endsWith("/threads/a/submit")).length, 1, "the note posts once");
		assert.equal(posts.some((u) => u.endsWith("/cards/p1/submit")), false);
		assert.equal(mem.get("wolfpack:draft:w:w/a") ?? "", "");
	});

	it("Submit while dictating only stops the run and fills the field; the next press sends it", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("send this");
		await fire(q('[data-testid="chat-bar"] form')!, "submit");
		await fire(q('[data-testid="chat-bar"] form')!, "submit"); // pressed again while the run settles: nothing
		await endRun(ws);
		await wait();
		assert.equal(posts.filter((u) => u.endsWith("/threads/a/submit")).length, 0, "first press does not send");
		assert.equal(barTa()!.value, "send this");
		await fire(q('[data-testid="chat-bar"] form')!, "submit");
		await wait();
		assert.equal(posts.filter((u) => u.endsWith("/threads/a/submit")).length, 1);
		assert.equal(barTa()!.value, "");
	});

	it("opening the thread page from the chip finishes the run first, so the words land in the draft; the chat stays attached and the page composer takes over", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("spoken words");
		await fire(q('[data-testid="chat-bar-chip"]')!, "click");
		await fire((q('[data-testid="den-thread"][aria-current="true"]')!.closest('[data-testid="den-thread-group"]')!.querySelector('[data-testid="den-thread-open"]') as HTMLElement)!, "click");
		await endRun(ws);
		await wait();
		assert.equal(q('[data-testid="path"]')!.textContent, "/wolf/w/thread/a");
		assert.equal(q('[data-testid="chat-bar"]'), null, "the page composer is the chat there");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a", "still attached");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "spoken words");
		assert.deepEqual(posts, []);
	});

	describe("Cmd+D goes to the right input", () => {
		async function dictateByKey(text: string) {
			await key();
			await wait();
			const ws = await say(text);
			await key(); // stop
			await endRun(ws);
			await wait();
		}

		it("focus in the floating chat → the floating chat, even on a page with its own composer", async () => {
			await mount("/graph", A, <PageComposer />);
			barTa()!.focus();
			await dictateByKey("to the bar");
			assert.equal(barTa()!.value, "to the bar");
			assert.equal(pageTa().value, "");
		});

		it("a page with its own composer and focus elsewhere → that page's composer", async () => {
			await mount("/graph", A, <PageComposer />);
			pageTa().focus();
			await dictateByKey("to the page");
			assert.equal(pageTa().value, "to the page");
			assert.equal(barTa()!.value, "");
		});

		it("any other page → the floating chat; and a run in progress is not stolen by navigation", async () => {
			await mount("/graph", A, <PageComposerOnThreads />);
			await dictateByKey("to the bar from the graph");
			assert.equal(barTa()!.value, "to the bar from the graph");
			// A live run keeps its owner when a page with a composer mounts: the next Cmd+D stops it, it does not start a second.
			await key();
			await wait();
			const ws = await say("still the bar");
			await act(async () => go("/wolf/w/thread/b"));
			await wait();
			await key();
			await endRun(ws);
			await wait();
			assert.equal(FakeWS.count, 2, "one run per toggle pair");
			await wait(400);
			assert.match(mem.get("wolfpack:draft:w:w/a") ?? "", /still the bar/);
			assert.equal(pageTa().value, "", "the page composer got nothing");
		});

		it("with nothing popped out Cmd+D starts nothing", async () => {
			await mount("/graph", null);
			await key();
			await wait();
			assert.equal(FakeWS.count, 0);
		});
	});
});

/** A thread page's composer as thread-chat builds it: draft restored from storage at mount, text kept in a ref. */
function PageDraftComposer() {
	const api = useAttachedThread();
	const barShown = useBarShown();
	const [text, setText] = React.useState("");
	const textRef = React.useRef("");
	const schedule = useComposerDraft("w", "w/a", textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	// The floating chat replaces this composer while it owns the input (as ThreadChat does).
	const hidden = api?.attached?.threadId === "w/a" && barShown;
	useRereadDraftWhenShown(hidden, "w", "w/a", textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	if (hidden) return null;
	return (
		<form data-testid="composer">
			<textarea data-testid="page-ta" value={text} onChange={(e) => (textRef.current = e.target.value, setText(e.target.value), schedule(e.target.value))} />
		</form>
	);
}
const OnThreadA = () => (usePathname() === "/wolf/w/thread/a" ? <PageDraftComposer /> : null);

describe("floating chat dictation: docking details", () => {
	it("a second dock-path click while the first waits for the run does nothing", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("words");
		const before = navLog.stack.length;
		await fire(q('[data-testid="chat-bar-chip"]')!, "click");
		await fire((q('[data-testid="den-thread"][aria-current="true"]')!.closest('[data-testid="den-thread-group"]')!.querySelector('[data-testid="den-thread-open"]') as HTMLElement)!, "click");
		await fire((q('[data-testid="den-thread"][aria-current="true"]')!.closest('[data-testid="den-thread-group"]')!.querySelector('[data-testid="den-thread-open"]') as HTMLElement)!, "click");
		await endRun(ws);
		await wait();
		assert.equal(navLog.stack.length, before + 1, "one navigation");
	});

	it("landing on the thread's page while the bar dictates keeps the run with the page composer in place; stopping there docks and the composer has the words", async () => {
		await mount("/kb", A, <OnThreadA />);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("the tail");
		await act(async () => go("/wolf/w/thread/a"));
		await wait();
		assert.equal(ws.readyState, 1, "landing did not stop the run");
		assert.equal(q('[data-testid="chat-bar"]'), null, "no floating chat over the page's own composer");
		assert.equal(document.querySelectorAll('[data-testid="page-ta"]').length, 1, "the page composer is in place");
		await key(); // Cmd+D stops it (this stand-in page has no meter of its own)
		await endRun(ws);
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), null, "docked");
		assert.equal(pageTa().value, "the tail");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "the tail");
	});
});

describe("the phone dock dictates in place", () => {
	it("the live transcript replaces the text field while dictating, and the words land in the field for review on finish, unsent", async () => {
		const w = window as unknown as { matchMedia?: unknown };
		w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
		try {
			await mount("/kb", A);
			const form = () => q('[data-testid="chat-bar"] [data-testid="composer"]')!;
			assert.equal(form().getAttribute("data-field"), "voice");
			await fire(form(), "submit"); // the big mic starts the run
			await wait();
			const ws = await say("live words");
			assert.equal(form().getAttribute("data-field"), "transcript");
			assert.equal(q('[data-testid="dictation-transcript"]')!.textContent, "live words");
			assert.ok(q('[data-testid="composer"][data-field="transcript"] [data-testid="dictation-meter"]'), "the level meter rides with the transcript");
			await fire(form(), "submit"); // the same big button stops the run
			await endRun(ws);
			await wait();
			assert.equal(form().getAttribute("data-field"), "text");
			assert.equal(barTa()!.value, "live words");
			assert.equal(q('[data-testid="dictation-transcript"]'), null);
			assert.deepEqual(posts, []);
		} finally {
			delete w.matchMedia;
		}
	});
});

/** The phone dock: matchMedia says the shared PHONE_QUERY matches for the duration of `run`. */
async function onPhone(run: () => Promise<void>) {
	const w = window as unknown as { matchMedia?: unknown };
	w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
	try {
		await run();
	} finally {
		delete w.matchMedia;
	}
}
const phoneForm = () => q('[data-testid="chat-bar"] [data-testid="composer"]')!;
const mainBtn = () => q('[data-testid="voice-main"]')!;
const reactProps = (el: Element) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!];
const remount = async (stored: object | null) => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	dataStore.clear(); // re-read the thread list (its status changed)
	await mount("/kb", stored);
};

describe("the phone dock's voice layout", () => {
	it("the big button is the mic when idle and empty, Send with a draft, Stop while the wolf works with nothing to send, Stop dictation while recording and a spinner while flushing", async () => {
		await onPhone(async () => {
			await mount("/kb", A);
			assert.equal(mainBtn().getAttribute("aria-label"), "Start dictation");
			await typeInBar("a draft");
			assert.equal(mainBtn().getAttribute("aria-label"), "Send");
			busyA = true;
			await remount(A);
			await wait();
			assert.equal(mainBtn().getAttribute("aria-label"), "Send", "a draft is still Send while the wolf works");
			await typeInBar("");
			assert.equal(mainBtn().getAttribute("aria-label"), "Stop", "working and empty: the one button is Stop");
			busyA = false;
			await remount(A);
			await wait();
			assert.equal(mainBtn().getAttribute("aria-label"), "Start dictation", "idle again: the mic");
			await fire(phoneForm(), "submit");
			await wait();
			const ws = await say("spoken");
			assert.equal(mainBtn().getAttribute("aria-label"), "Stop dictation");
			await fire(phoneForm(), "submit");
			assert.equal(mainBtn().getAttribute("aria-label"), "Finishing dictation");
			assert.equal(mainBtn().hasAttribute("disabled"), true);
			await endRun(ws);
		});
	});

	it("the Stop button aborts the working wolf's turn", async () => {
		busyA = true;
		await onPhone(async () => {
			await mount("/kb", A);
			await wait();
			await fire(phoneForm(), "submit");
			await wait();
			assert.equal(posts.filter((u) => /\/threads\/a\/abort$/.test(u)).length, 1);
		});
	});

	it("the first press with no Deepgram key opens Pack → Keys at once, without starting a run", async () => {
		const { setPackNavigator } = await import("../../../components/pack/pack-nav.ts");
		const went: string[] = [];
		setPackNavigator((href) => void went.push(href));
		(window as any).location = { pathname: "/kb", search: "" };
		keylessToken = true;
		try {
			await onPhone(async () => {
				await mount("/kb", A);
				await wait();
				await fire(phoneForm(), "submit");
				assert.deepEqual(went, ["/pack/keys"]);
				assert.equal(FakeWS.count, 0);
			});
		} finally {
			setPackNavigator(null);
		}
	});

	it("a draft stays visible, dimmed, above the transcript while dictating; Esc cancels: no text lands, the transcript clears and the field is back to the draft", async () => {
		mem.set("wolfpack:draft:w:w/a", "keep me");
		await onPhone(async () => {
			await mount("/kb", A);
			assert.equal(phoneForm().getAttribute("data-field"), "text");
			await key(); // with a draft the big button is Send, so the run starts by Cmd+D
			await wait();
			await say("thrown away");
			assert.equal(phoneForm().getAttribute("data-field"), "transcript");
			assert.equal(q('[data-testid="dictation-draft"]')!.textContent, "keep me");
			assert.equal(q('[data-testid="dictation-transcript"]')!.textContent, "thrown away");
			await act(async () => void reactProps(phoneForm()).onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} }));
			await wait();
			assert.equal(q('[data-testid="dictation-transcript"]'), null);
			assert.equal(q('[data-testid="dictation-draft"]'), null);
			assert.equal(phoneForm().getAttribute("data-field"), "text");
			assert.equal(barTa()!.value, "keep me");
		});
	});

	it("swapping threads during a voice run keeps the transcript until the run ends, then the new thread's field starts clean and the words are in the old thread's draft", async () => {
		await onPhone(async () => {
			await mount("/wolf/w/thread/c", A);
			await fire(phoneForm(), "submit");
			await wait();
			const ws = await say("for a");
			await fire(q('[data-testid="chat-bar-swap"]')!, "click");
			assert.equal(phoneForm().getAttribute("data-field"), "transcript", "still showing the run");
			assert.equal(q('[data-testid="dictation-transcript"]')!.textContent, "for a");
			await endRun(ws);
			await wait();
			assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/c");
			assert.equal(q('[data-testid="chat-bar"]'), null, "c's own page: the page composer is the chat");
			await act(async () => go("/kb")); // the dock is back, now for c
			await wait();
			assert.equal(phoneForm().getAttribute("data-field"), "voice", "c has no draft");
			assert.equal(q('[data-testid="dictation-transcript"]'), null);
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "for a");
		});
	});

	it("on desktop the composer keeps the classic row: no voice layout and the dictation bar slot is still there", async () => {
		await mount("/kb", A);
		assert.equal(phoneForm().getAttribute("data-field"), null);
		assert.ok(q('[data-testid="chat-bar"] [data-testid="dictation-slot"]'));
	});
});

describe("a mounted composer keeps both the owner's edit and the dictated tail", () => {
	it("phone (no dock on thread pages): an edited page composer ends with its text plus the tail, and the store keeps both after the next debounced write", async () => {
		const w = window as unknown as { matchMedia?: unknown };
		w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
		try {
			await mount("/kb", A, <OnThreadA />);
			await fire(q('[data-testid="chat-bar"] [data-testid="composer"]')!, "submit"); // the phone dock's big mic starts the run
			await wait();
			const ws = await say("the tail");
			await act(async () => go("/wolf/w/thread/a"));
			await wait();
			const type = (v: string) =>
				act(async () => {
					const el = pageTa();
					el.value = v;
					const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"))!;
					(el as any)[k].onChange({ target: el, currentTarget: el });
				});
			await type("typed meanwhile");
			await endRun(ws);
			await wait();
			assert.equal(pageTa().value, "typed meanwhile the tail");
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "typed meanwhile the tail", "store updated at once");
			await type("typed meanwhile the tail, and more");
			await wait(400);
			assert.equal(mem.get("wolfpack:draft:w:w/a"), "typed meanwhile the tail, and more");
		} finally {
			delete w.matchMedia;
		}
	});
});

describe("useDictation lifecycle", () => {
	it("unmounting mid-run stops the mic and closes the socket, and sends the received words to onOrphan (never to append)", async () => {
		const appended: string[] = [];
		const orphaned: string[] = [];
		function Probe() {
			const d = useDictation({ append: (t) => void appended.push(t), onOrphan: (t) => void orphaned.push(t) });
			return <DictationBar dictation={d} />;
		}
		await mount("/kb", null);
		const host = document.createElement("div");
		document.body.appendChild(host);
		const probe = createRoot(host);
		await act(async () => probe.render(<><Probe /></>));
		await fire(host.querySelector('[data-testid="dictation-toggle"]')!, "click", { detail: 1 });
		await wait();
		const ws = await say("never lands");
		await act(async () => probe.unmount());
		assert.equal(ws.readyState, 3, "socket closed");
		assert.ok(stops >= 1, "mic track stopped");
		assert.deepEqual(appended, []);
		assert.deepEqual(orphaned, ["never lands"]);
	});

	it("the bar unmounting mid-run saves the received words into the popped-out thread's draft", async () => {
		await mount("/kb", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("bar words");
		await act(async () => root?.unmount());
		root = null;
		assert.equal(ws.readyState, 3, "socket closed");
		assert.ok(stops >= 1, "mic stopped");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "bar words");
	});

	it("the page hook pre-mints the token at mount; the bar's only once something is popped out", async () => {
		await mount("/kb", null, <AttachBtn />);
		assert.equal(tokenFetches, 0, "bar hook idle with nothing popped out");
		await fire(q('[data-testid="test-attach"]')!, "click");
		await wait();
		assert.ok(tokenFetches >= 1, "pre-minted once popped out");
		await act(async () => root?.unmount());
		root = null;
		tokenFetches = 0;
		document.body.innerHTML = "";
		await mount("/wolf/w/thread/b", null, <PageComposer />);
		assert.ok(tokenFetches >= 1, "a page composer's hook pre-mints at mount");
	});
});

/** Test stand-in for "something got popped out" (the product has no Pop out button; dictation does it). */
function AttachBtn() {
	const api = useAttachedThread();
	return <button type="button" data-testid="test-attach" onClick={() => api!.attach({ wolf: "w", threadId: "w/a", slug: "a" })} />;
}

/** A thread page as ThreadChat wires it: draft composer + the page's dictation hook (the page's dictation bar hides while the floating chat shows the run). */
function ThreadPage({ slug }: { slug: "a" | "b" }) {
	const id = `w/${slug}`;
	const [text, setText] = React.useState("");
	const textRef = React.useRef("");
	const schedule = useComposerDraft("w", id, textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	const api = useAttachedThread();
	// The attached thread's page has no composer of its own: the bar docks there (the real ThreadChat renders a dock slot).
	const barOwns = api?.attached?.threadId === id;
	const d = useThreadDictation(
		(t) => {
			const v = joinDictation(textRef.current, t);
			textRef.current = v;
			setText(v);
			schedule(v);
		},
		(t) => appendToDraft(draftKey("w", id), t),
	);
	// The floating chat replaces the composer while it owns the input; on return the composer re-reads the draft.
	useRereadDraftWhenShown(barOwns, "w", id, textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	if (barOwns) return null;
	return (
		<form data-testid="composer">
			<textarea data-testid="page-ta" value={text} onChange={(e) => (textRef.current = e.target.value, setText(e.target.value), schedule(e.target.value))} />
			<div data-testid="page-dictation"><DictationBar dictation={d} /></div>
		</form>
	);
}
const OnPageA = () => (usePathname() === "/wolf/w/thread/a" ? <ThreadPage slug="a" /> : null);
const OnPages = () => {
	const p = usePathname();
	return p === "/wolf/w/thread/a" ? <ThreadPage slug="a" /> : p === "/wolf/w/thread/b" ? <ThreadPage slug="b" /> : p === "/chat/new" ? <NewPage /> : null;
};
/** /chat/new: no thread yet, a plain page hook that saves orphaned words to a draft. */
function NewPage() {
	const d = useDictation({ append: () => {}, onOrphan: (t) => appendToDraft(draftKey("w", "new"), t) });
	return (
		<form data-testid="composer">
			<textarea data-testid="page-ta" />
			<div data-testid="page-dictation"><DictationBar dictation={d} /></div>
		</form>
	);
}
/** Microtask ticks between two presses: lands after the handoff started but before the bar run is live. */
const TICKS = 2;
const pageComposerCount = () => document.querySelectorAll('form[data-testid="composer"]').length - document.querySelectorAll('[data-testid="chat-bar"] form[data-testid="composer"]').length;
const typeInBar = (v: string) =>
	act(async () => {
		const el = barTa()!;
		el.value = v;
		const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"))!;
		(el as any)[k].onChange({ target: el, currentTarget: el });
	});
const pageToggle = () => q('[data-testid="page-dictation"] [data-testid="dictation-toggle"]')!;

describe("one dictation path: the bar's when a thread is attached, the page's own only with nothing attached", () => {
	it("on the attached thread's page the bar's run is the only run (the page hook stays idle), and the words land in the docked bar's input, unsent", async () => {
		await mount("/wolf/w/thread/a", A, <><OnPageA /><DockSlot /></>);
		assert.equal(pageComposerCount(), 0, "no page composer: the bar is the composer there");
		assert.ok(q('[data-testid="thread-dock-slot"] [data-testid="chat-bar"]'), "the bar sits in the page's dock slot");
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("spoken once");
		await endRun(ws);
		await wait();
		assert.equal(FakeWS.count, 1, "one socket");
		assert.equal(barTa()!.value, "spoken once", "in the docked bar's input");
		assert.deepEqual(posts, [], "nothing sent");
	});

	it("docking and undocking move the same bar: its element and its input survive, so unsent state is not lost", async () => {
		await mount("/kb", A, <><OnPageA /><DockSlot /></>);
		const bar = q('[data-testid="chat-bar"]')!;
		const input = barTa()!;
		assert.ok(bar && input);
		await act(async () => go("/wolf/w/thread/a"));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), bar, "the same element after docking");
		assert.equal(barTa(), input, "the same input after docking");
		assert.ok(q('[data-testid="thread-dock-slot"]')!.contains(bar), "and it now sits in the page's slot");
		await act(async () => go("/kb"));
		await wait();
		assert.equal(q('[data-testid="chat-bar"]'), bar, "the same element after undocking");
		assert.equal(barTa(), input, "the same input after undocking");
		assert.ok(!q('[data-testid="thread-dock-slot"]')!.contains(bar), "and it left the slot");
	});

	it("Cmd+J on the attached thread's page focuses the docked bar's input", async () => {
		await mount("/wolf/w/thread/a", A, <><OnPageA /><DockSlot /></>);
		let focusedBar = false;
		barTa()!.focus = () => void (focusedBar = true);
		let prevented = false;
		window.dispatchEvent(new dom.window.CustomEvent("wolfpack:kbd-focus-chat-bar", { detail: { event: { preventDefault: () => void (prevented = true) } } }));
		assert.ok(prevented && focusedBar);
	});

	it("a dictation-autosend event sends what was dictated through the send path and clears the input", async () => {
		await mount("/wolf/w/thread/a", A, <><OnPageA /><DockSlot /></>);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("ship it");
		await endRun(ws);
		await wait();
		assert.equal(barTa()!.value, "ship it");
		assert.deepEqual(posts, [], "nothing sent yet");
		await act(async () => void window.dispatchEvent(new dom.window.CustomEvent("wolfpack:dictation-autosend", { detail: { wolf: "w", threadId: "w/a" } })));
		await wait();
		assert.equal((posts as string[]).filter((p) => p.includes("/submit")).length, 1, "sent once");
		assert.equal(barTa()!.value, "", "the input is cleared");
	});

	it("a dictation-autosend event started for another thread (or carrying no thread) sends nothing from this composer", async () => {
		await mount("/wolf/w/thread/a", A, <><OnPageA /><DockSlot /></>);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("typed here");
		await endRun(ws);
		await wait();
		await act(async () => void window.dispatchEvent(new dom.window.CustomEvent("wolfpack:dictation-autosend", { detail: { wolf: "w", threadId: "w/other" } })));
		await act(async () => void window.dispatchEvent(new dom.window.CustomEvent("wolfpack:dictation-autosend")));
		await wait();
		assert.deepEqual(posts, [], "nothing sent");
		assert.equal(barTa()!.value, "typed here", "the text stays");
	});

	it("with nothing attached the page's own run works and the words land in the page composer", async () => {
		await mount("/wolf/w/thread/a", null, <OnPageA />);
		assert.equal(mem.get(ATTACHED_KEY), undefined);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("fallback words");
		await endRun(ws);
		await wait();
		assert.equal(pageTa().value, "fallback words");
		assert.equal(mem.get(ATTACHED_KEY), undefined, "dictating does not attach anything");
	});

	it("/chat/new has no thread to pop out: its own run, and leaving saves the words and stops the mic", async () => {
		await mount("/chat/new", null, <OnPages />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("new chat words");
		assert.equal(mem.get(ATTACHED_KEY), undefined, "nothing popped out");
		await act(async () => go("/graph"));
		await wait();
		assert.equal(ws.readyState, 3, "socket closed");
		assert.equal(mem.get("wolfpack:draft:w:new"), "new chat words");
	});
});

describe("the swap pill and dictation", () => {
	const pill = () => q('[data-testid="chat-bar-swap"]')!;

	it("choosing the pill while the bar is dictating finishes that run first, so the words land in the draft, then swaps", async () => {
		await mount("/wolf/w/thread/b", A);
		await fire(barToggle(), "click", { detail: 1 });
		await wait();
		const ws = await say("spoken for a");
		await fire(pill(), "click");
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/a", "still attached until the run has ended");
		await endRun(ws);
		await wait();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/b", "swapped");
		assert.equal(mem.get("wolfpack:draft:w:w/a"), "spoken for a");
		assert.deepEqual(posts, []);
	});

	it("the pill finishes only the bar's run: a page composer's live run keeps going", async () => {
		await mount("/wolf/w/thread/b", A, <PageComposer />);
		await fire(pageToggle(), "click", { detail: 1 });
		await wait();
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		await fire(pill(), "click");
		await wait();
		assert.equal(JSON.parse(mem.get(ATTACHED_KEY)!).threadId, "w/b", "swapped");
		assert.equal(ws.sent.some((m) => typeof m === "string" && m.includes("CloseStream")), false, "the page run was not told to stop");
		assert.equal(ws.readyState, 1);
	});
});
