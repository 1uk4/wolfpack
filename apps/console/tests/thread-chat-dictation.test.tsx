/**
 * ThreadChat dictation wiring (real mount; fake Deepgram socket + mic, no real audio): the bar renders in the dock,
 * finishing inserts into the composer or the focused card field (free-text / Other), composer focus hands the target
 * back, Esc and the wolfpack:kbd-* events drive the run, Send/Submit while recording include the final tail exactly once,
 * Stop stays available while a turn runs, and a missing key shows the keyless hint.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
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

const { MockConsoleClient, FIXTURE_THREAD, NotFoundError } = await import("@wolfpack/client");
type Card = import("@wolfpack/client").Card;
type CardAnswers = import("@wolfpack/client").CardAnswers;
type ThreadDetail = import("@wolfpack/client").ThreadDetail;
const { createThreadApi } = await import("../src/server/thread-api.ts");
const { cardsOfThread, threadMessagesToNative } = await import("../src/core/index.ts");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");
const { MemoryEventsProvider } = await import("../components/memory-events.tsx");
const { FakeNav } = await import("./helpers/fake-nav.tsx");
const { useRouter } = await import("next/navigation");
let goTo: (href: string) => void = () => {};
function RouterGrab() {
	goTo = useRouter().push;
	return null;
}
const { ServerEventsProvider } = await import("../components/server-events.tsx");
const { AttachedThreadProvider } = await import("../components/attached-thread.tsx");
const { ChatBar } = await import("../components/chat-bar.tsx");
const { ATTACHED_KEY } = await import("../src/core/chat-bar.ts");
const inertSource = () => ({ close() {}, onOpen() {}, onMessage() {}, onError() {} });

const CALL = "call-1";
const MIXED: Card = {
	tool: "ask_user_question",
	fields: [
		{ id: "why", kind: "free-text", label: "Why?" },
		{ id: "pick", kind: "single", label: "Which?", options: [{ label: "a", value: "a" }, { label: "b", value: "b" }] },
	],
};

class CardClient extends MockConsoleClient {
	constructor(private readonly card: Card | null) {
		super({ delayMs: 0, script: [{ kind: "text", text: "ok" }] });
	}
	override async getThread(id: string): Promise<ThreadDetail> {
		const base = await super.getThread(id);
		if (!this.card) return base;
		const asked = {
			id: "entry-1",
			role: "assistant" as const,
			text: "",
			at: new Date().toISOString(),
			tools: [{ callId: CALL, name: "ask_user_question", args: { question: "q" }, result: "asked", card: this.card }],
		};
		const pendingCards = [{ callId: CALL, threadId: id, card: this.card, raisedAt: new Date().toISOString() }];
		return { ...base, messages: [asked, ...base.messages], pendingCards };
	}
}

// ---- fake mic + Deepgram socket (the hook's browser seams) ----
class FakeWS {
	static OPEN = 1;
	static CONNECTING = 0;
	static last: FakeWS | null = null;
	readyState = 0;
	sent: unknown[] = [];
	private ls = new Map<string, ((ev: unknown) => void)[]>();
	constructor() {
		FakeWS.last = this;
	}
	addEventListener(t: string, f: (ev: unknown) => void) {
		this.ls.set(t, [...(this.ls.get(t) ?? []), f]);
	}
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
	static last: FakeCtx | null = null;
	state = "running";
	/** Resolves the pending suspend() when set (lets a test hold it open). */
	holdSuspend: Promise<void> | null = null;
	constructor() {
		FakeCtx.last = this;
	}
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() {
		return new FakeNode();
	}
	async resume() {
		this.state = "running";
	}
	async suspend() {
		await this.holdSuspend;
		this.state = "suspended";
	}
}
let tokenStatus = 200;
Object.assign(globalThis, { WebSocket: FakeWS, AudioContext: FakeCtx, AudioWorkletNode: FakeNode });
Object.defineProperty(globalThis, "navigator", {
	configurable: true,
	value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
});

const realFetch = globalThis.fetch;
let root: Root | null = null;

/** POSTs the page made (card answers, submits), bodies parsed. */
let posts: { url: string; body: any }[] = [];

async function mount(client: CardClient, opts: { inFlight?: boolean; poppedOut?: boolean } = {}) {
	posts = [];
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (init?.method === "POST") {
			posts.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
			return new Response(JSON.stringify({ disposition: "queued" }), { status: 200 });
		}
		if (opts.inFlight && url.includes("/stream")) return new Promise<Response>(() => {}); // a turn that never ends
		if (url.includes("/api/stt/token")) {
			return tokenStatus === 200
				? new Response(JSON.stringify({ token: "tok" }), { status: 200 })
				: new Response(JSON.stringify({ message: "no key" }), { status: tokenStatus });
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
	const detail = await client.getThread(FIXTURE_THREAD.id);
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	const chat = (
		<SettingsDialogProvider>
			<MemoryEventsProvider connect={inertSource}>
				<ThreadChat
					wolf="1uk4"
					slug="home"
					threadId={FIXTURE_THREAD.id}
					title="Home"
					initialMessages={threadMessagesToNative(detail.messages)}
					initialCards={cardsOfThread(detail)}
					initiallyInFlight={opts.inFlight}
				/>
			</MemoryEventsProvider>
		</SettingsDialogProvider>
	);
	if (opts.poppedOut) store.set(ATTACHED_KEY, JSON.stringify({ wolf: "1uk4", slug: "home", threadId: FIXTURE_THREAD.id }));
	await act(async () => {
		root!.render(
			opts.poppedOut ? (
				<FakeNav start="/wolf/1uk4/thread/home">
					<SettingsDialogProvider>
						<ServerEventsProvider connect={() => ({ close() {}, onOpen() {}, onEvent() {} })}>
							<AttachedThreadProvider>
								<ChatBar />
								<RouterGrab />
								{chat}
							</AttachedThreadProvider>
						</ServerEventsProvider>
					</SettingsDialogProvider>
				</FakeNav>
			) : (
				<AppRouterContext.Provider value={{ push() {} } as never}>{chat}</AppRouterContext.Provider>
			),
		);
	});
}

const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const click = (el: Element) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
	});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const toggle = () => q('[data-testid="dictation-toggle"]')!;
/** Focus a field the way the browser would: focus handler (React listens to focusin) + the document event. */
const focus = (el: HTMLElement) =>
	act(async () => {
		el.dispatchEvent(new dom.window.Event("focusin", { bubbles: true }));
	});
const esc = () => Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" });
// linkedom lacks the IE input-event hooks React's focus path pokes at.
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });
const composer = () => q('[data-testid="composer"] textarea') as HTMLTextAreaElement;

/** Start a run, deliver finals, stop and let the socket close: the deferred transcript flushes. */
async function dictate(...finals: string[]) {
	await click(toggle());
	await settle();
	const ws = FakeWS.last!;
	await act(async () => ws.open());
	await act(async () => finals.forEach((f) => ws.final(f)));
	await click(toggle()); // Stop
	await act(async () => ws.emit("close", { code: 1000 }));
	await settle();
}

/** Begin a run and deliver finals, leaving it recording (the socket stays open for a later close). */
async function recording(...finals: string[]) {
	await click(toggle());
	await settle();
	const ws = FakeWS.last!;
	await act(async () => ws.open());
	await act(async () => finals.forEach((f) => ws.final(f)));
	return ws;
}
/** Let Deepgram close the socket after our CloseStream: the run ends and the tail flushes. */
const closeSocket = (ws: FakeWS) => act(async () => ws.emit("close", { code: 1000 }));
/** Type into a textarea the way the browser does: set the value, then fire React's onChange. */
const typeIn = (el: HTMLTextAreaElement, v: string) =>
	act(async () => {
		el.value = v;
		const k = Object.keys(el).find((x) => x.startsWith("__reactProps$"))!;
		(el as any)[k].onChange({ target: el, currentTarget: el });
	});
/** Navigate away from the thread's page (the page stays mounted in this harness) so a live run shows as the floating chat. */
const leavePage = async () => {
	await act(async () => goTo("/graph"));
	await settle(60);
};
const barTa = () => q('[data-testid="chat-bar"] textarea') as HTMLTextAreaElement | null;
/** Composer cards on the thread page itself (the floating chat's own card is inside [data-testid="chat-bar"]). */
const pageComposers = () => document.querySelectorAll('[data-testid="composer"]').length - document.querySelectorAll('[data-testid="chat-bar"] [data-testid="composer"]').length;
const DRAFT = () => store.get(`wolfpack:draft:1uk4:${FIXTURE_THREAD.id}`);
const press = (el: Element, init: { key: string; metaKey?: boolean }) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), init));
	});

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	tokenStatus = 200;
	FakeWS.last = null;
	store.clear();
	document.body.innerHTML = "";
});

describe("ThreadChat dictation", () => {
	it("renders the dictation bar in the dock; recording swaps in the meter", async () => {
		await mount(new CardClient(null));
		assert.ok(q('[data-testid="dictation-slot"] [data-testid="dictation-toggle"]'));
		assert.equal(q('[data-testid="dictation-bar"]'), null);
		await click(toggle());
		assert.ok(q('[data-testid="dictation-bar"]'), "meter shows from the click");
		await act(async () => window.dispatchEvent(new CustomEvent("wolfpack:kbd-cancel-dictation")));
		assert.equal(q('[data-testid="dictation-bar"]'), null);
	});

	it("leaving the page mid-run saves the received words into the thread's draft and stops the mic and socket", async () => {
		await mount(new CardClient(null));
		const ws = await recording("heard before leaving");
		await act(async () => root?.unmount());
		root = null;
		assert.equal(ws.readyState, 3, "socket closed");
		assert.equal(store.get(`wolfpack:draft:1uk4:${FIXTURE_THREAD.id}`), "heard before leaving");
	});

	it("a finished run suspends the shared AudioContext (no idle audio output); a start right after a stop ends running, even if the suspend lands late", async () => {
		await mount(new CardClient(null));
		await dictate("one");
		const ctx = FakeCtx.last!;
		assert.equal(ctx.state, "suspended", "suspended after the run");
		// Next run: its stop's suspend is slow, and a third run starts before it lands.
		await dictate("two");
		let release!: () => void;
		ctx.holdSuspend = new Promise<void>((r) => (release = r));
		await click(toggle());
		await settle();
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		await click(toggle()); // Stop: suspend() now pending
		await act(async () => ws.emit("close", { code: 1000 }));
		await click(toggle()); // start again before the suspend resolves
		await settle();
		release();
		await settle(60);
		assert.equal(ctx.state, "running", "the new run is not left suspended");
	});

	it("finishing inserts the transcript into the composer; a second run appends to it", async () => {
		await mount(new CardClient(null));
		await dictate("hello", "brave");
		assert.equal(composer().value, "hello brave");
		await dictate("new world");
		assert.equal(composer().value, "hello brave new world");
	});

	it("a focused card free-text field becomes the target; focusing the composer hands it back", async () => {
		await mount(new CardClient(MIXED));
		const field = q('[data-testid="card-text"]') as HTMLTextAreaElement;
		await focus(field);
		assert.ok(q("[data-dictation-claimed]"), "card claims the target");
		await dictate("because reasons");
		assert.equal(field.value, "because reasons");
		assert.equal(composer().value, "");
		await focus(composer());
		assert.equal(q("[data-dictation-claimed]"), null, "composer focus releases the claim");
		await dictate("to the composer");
		assert.equal(composer().value, "to the composer");
		assert.equal(field.value, "because reasons");
	});

	it("the Other input is a target too, and the dictated text counts as an Other answer", async () => {
		await mount(new CardClient({ tool: "ask_user_question", fields: [{ id: "pick", kind: "single", label: "Which?", options: [{ label: "a", value: "a" }] }] }));
		const other = q('[data-testid="card-other"]') as HTMLInputElement;
		await focus(other);
		await dictate("something else");
		assert.equal(other.value, "something else");
		assert.equal(q('[data-testid="card-submit"]')!.hasAttribute("aria-disabled"), false);
	});

	it("Esc in a card field cancels the run and discards the transcript", async () => {
		await mount(new CardClient(MIXED));
		const field = q('[data-testid="card-text"]') as HTMLTextAreaElement;
		await focus(field);
		await click(toggle());
		await settle();
		await act(async () => FakeWS.last!.open());
		await act(async () => FakeWS.last!.final("never lands"));
		await act(async () => {
			field.dispatchEvent(esc());
		});
		assert.equal(q('[data-testid="dictation-bar"]'), null);
		assert.equal(field.value, "");
	});

	it("Esc in the composer cancels a live run", async () => {
		await mount(new CardClient(null));
		await click(toggle());
		await act(async () => {
			composer().dispatchEvent(esc());
		});
		assert.equal(q('[data-testid="dictation-bar"]'), null);
	});

	it("a missing Deepgram key shows the keyless hint on the idle button", async () => {
		tokenStatus = 503;
		await mount(new CardClient(null));
		await click(toggle());
		await settle();
		assert.match(toggle().textContent ?? "", /Dictation needs a Deepgram key/);
	});

	it("Send while recording finishes the run first and does not send; the next Send submits the field with the final tail", async () => {
		await mount(new CardClient(null));
		await dictate("typed"); // linkedom cannot type: a first run seeds the composer
		const ws = await recording("spoken tail");
		// linkedom does not submit forms on a button click: fire the submit the button would.
		await act(async () => {
			composer().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		await closeSocket(ws);
		await settle();
		assert.equal(posts.filter((p) => !p.url.includes("abort")).length, 0, "first press does not send");
		assert.equal(composer().value, "typed spoken tail");
		await act(async () => {
			composer().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		await settle();
		const sent = posts.filter((p) => !p.url.includes("abort"));
		assert.equal(sent.length, 1);
		assert.match(JSON.stringify(sent[0]!.body), /typed spoken tail/);
	});

	it("popped out: Enter while the floating chat's run is live stops it and fills the composer without sending; the next Enter sends", async () => {
		// A running turn makes Enter a steer, whose POST succeeds in the fake (a plain send would hit the unmocked stream and be restored).
		await mount(new CardClient(null), { poppedOut: true, inFlight: true });
		await dictate("typed"); // the bar's run (the page hook is off while popped out); the words reach the composer via the draft
		assert.equal(composer().value, "typed");
		const ws = await recording("spoken tail");
		await press(composer(), { key: "Enter" });
		await closeSocket(ws);
		await settle(400);
		assert.equal(posts.filter((p) => p.url.includes("/submit")).length, 0, "first press does not send");
		assert.equal(composer().value, "typed spoken tail");
		await press(composer(), { key: "Enter" });
		await settle(400);
		const sent = posts.filter((p) => p.url.includes("/submit"));
		assert.equal(sent.length, 1);
		assert.match(JSON.stringify(sent[0]!.body), /typed spoken tail/);
		assert.equal(composer().value, "");
		assert.equal(store.get(`wolfpack:draft:1uk4:${FIXTURE_THREAD.id}`), undefined, "nothing left in the draft");
	});

	it("dictating on the thread's own page keeps the page composer in place, highlighted, with no floating chat; stopping returns it to normal with typed plus dictated text, unsent", async () => {
		await mount(new CardClient(null), { poppedOut: true });
		await typeIn(composer(), "typed");
		await click(toggle());
		await settle(60);
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		assert.equal(q('[data-testid="chat-bar"]'), null, "no floating chat");
		assert.equal(pageComposers(), 1, "the page composer stays");
		assert.equal(composer().value, "typed");
		assert.equal(q('[data-testid="thread-composer-card"]')?.getAttribute("data-listening"), "true", "highlighted while listening");
		await act(async () => ws.final("tail"));
		await click(toggle()); // Stop
		await closeSocket(ws);
		await settle(60);
		assert.equal(q('[data-testid="chat-bar"]'), null);
		assert.equal(q('[data-testid="thread-composer-card"]')?.hasAttribute("data-listening"), false, "back to normal");
		assert.equal(composer().value, "typed tail");
		assert.deepEqual(posts, [], "nothing sent");
	});

	it("dictating on the thread's page then leaving it hands the run to the floating chat, which shows the words so far in its input", async () => {
		await mount(new CardClient(null), { poppedOut: true });
		await click(toggle());
		await settle(60);
		const ws = FakeWS.last!;
		await act(async () => ws.open());
		assert.equal(q('[data-testid="chat-bar"]'), null);
		await act(async () => goTo("/graph"));
		await settle(60);
		assert.ok(q('[data-testid="chat-bar"]'), "the floating chat follows");
		await act(async () => ws.final("away"));
		await click(q('[data-testid="chat-bar"] [data-testid="dictation-toggle"]')!);
		await closeSocket(ws);
		await settle(400);
		assert.equal(barTa()!.value, "away");
	});

	it("popped out, run followed off the page: a debounced page write pending at the hand-off cannot bring back text the owner cleared in the floating input", async () => {
		await mount(new CardClient(null), { poppedOut: true });
		await typeIn(composer(), "page text"); // debounce pending
		await click(toggle());
		await settle(60);
		await leavePage();
		assert.equal(barTa()!.value, "page text");
		await typeIn(barTa()!, ""); // clearing removes the draft at once
		await settle(500); // past the page's old debounce
		assert.equal(DRAFT(), undefined);
	});

	it("popped out, run followed off the page: words appended to the draft from outside while the chat owns the input are not merged into the hidden page composer's stale text", async () => {
		await mount(new CardClient(null), { poppedOut: true });
		await typeIn(composer(), "a");
		await click(toggle());
		await settle(60);
		await leavePage();
		await typeIn(barTa()!, "a b");
		await settle(500);
		const { appendToDraft, draftKey } = await import("../lib/composer-draft.ts");
		await act(async () => appendToDraft(draftKey("1uk4", FIXTURE_THREAD.id), "X"));
		await settle(60);
		assert.equal(DRAFT(), "a b X");
		assert.equal(barTa()!.value, "a b X");
	});

	it("popped out, run followed off the page: the floating chat says how many attachments wait in the page, and Enter there sends text only", async () => {
		await mount(new CardClient(null), { poppedOut: true, inFlight: true });
		const prev = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
			String(input).includes("/attachments") ? Response.json({ id: "up-1", name: "p.png", mimeType: "image/png", size: 4 }, { status: 201 }) : prev(input, init)) as typeof fetch;
		const png = new File([new Uint8Array([137, 80, 78, 71])], "p.png", { type: "image/png" });
		const chat = q('[data-testid="thread-chat"]')!;
		await act(async () => void chat.dispatchEvent(Object.assign(new dom.window.Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: { types: ["Files"], files: [png] } })));
		await settle(100);
		assert.equal(document.querySelectorAll('[data-testid="attachment-chip"]').length, 1, "the page holds one attachment");
		await click(toggle());
		await settle(60);
		await leavePage();
		assert.equal(pageComposers(), 0);
		assert.match(q('[data-testid="chat-bar-attachments-waiting"]')?.textContent ?? "", /^1 attachment waiting in the thread$/);
		await typeIn(barTa()!, "words only");
		await press(barTa()!, { key: "Enter" }); // the run is live: this press only stops it
		await closeSocket(FakeWS.last!);
		await settle(100);
		assert.equal(posts.filter((p) => p.url.includes("/submit")).length, 0, "first press does not send");
		await press(barTa()!, { key: "Enter" });
		await settle(100);
		const sent = posts.filter((p) => p.url.includes("/submit"));
		assert.equal(sent.length, 1);
		assert.doesNotMatch(JSON.stringify(sent[0]!.body), /up-1/);
	});

	it("Submit on a card while recording includes the tail; a double click answers once", async () => {
		await mount(new CardClient(MIXED));
		const field = q('[data-testid="card-text"]') as HTMLTextAreaElement;
		await focus(field);
		await dictate("because");
		await click(document.querySelectorAll('[data-testid="card-option"]')[0]!);
		const ws = await recording("and more");
		const submit = q('[data-testid="card-submit"]')!;
		await click(submit);
		await click(submit); // second click while the finish is pending
		assert.equal(submit.hasAttribute("disabled"), true, "Submit disabled while finishing");
		await closeSocket(ws);
		await settle();
		const answers = posts.filter((p) => p.url.includes("/cards/"));
		assert.equal(answers.length, 1);
		assert.equal(answers[0]!.body.answers.why.value, "because and more");
	});

	it("the wolfpack:kbd-toggle-dictation event starts and stops a run (⌘D)", async () => {
		await mount(new CardClient(null));
		await act(async () => window.dispatchEvent(new CustomEvent("wolfpack:kbd-toggle-dictation")));
		await settle();
		assert.ok(q('[data-testid="dictation-bar"]'), "run started");
		await act(async () => window.dispatchEvent(new CustomEvent("wolfpack:kbd-toggle-dictation")));
		await act(async () => FakeWS.last?.emit("close", { code: 1000 }));
		await settle();
		assert.equal(q('[data-testid="dictation-bar"]'), null, "run stopped");
	});

	it("while a turn runs, a live dictation keeps Stop available (not Send)", async () => {
		await mount(new CardClient(null), { inFlight: true });
		await click(toggle());
		await settle();
		const btn = document.querySelector('[data-testid="composer"] button[aria-label="Stop"], [data-testid="composer"] button[aria-label="Send"]')!;
		assert.equal(btn.getAttribute("aria-label"), "Stop");
	});

	it("multi Other is a target: dictated text lands in the pending entry and is folded on Submit", async () => {
		await mount(new CardClient({ tool: "ask_user_question", fields: [{ id: "envs", kind: "multi", label: "Which?", allowOther: true, options: [{ label: "dev", value: "dev" }] }] }));
		const other = q('[data-testid="card-other"]') as HTMLInputElement;
		await focus(other);
		await dictate("canary ring");
		assert.equal(other.value, "canary ring");
		// Second run while the first is still pending text: appended.
		await dictate("two");
		assert.equal(other.value, "canary ring two");
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		const answers = posts.filter((p) => p.url.includes("/cards/"));
		assert.equal(answers.length, 1);
		assert.match(JSON.stringify(answers[0]!.body.answers.envs), /canary ring two/);
	});

	it("free-text: Enter while dictating only stops the run (no newline) and the tail lands; the next Enter is the normal newline", async () => {
		await mount(new CardClient(MIXED));
		const field = q('[data-testid="card-text"]') as HTMLTextAreaElement;
		await focus(field);
		const ws = await recording("spoken answer");
		const enterEv = () => Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" });
		const first = enterEv();
		await act(async () => void field.dispatchEvent(first));
		assert.equal(first.defaultPrevented, true, "first Enter is claimed, no newline");
		await closeSocket(ws);
		await settle();
		assert.equal(field.value, "spoken answer");
		const next = enterEv();
		await act(async () => void field.dispatchEvent(next));
		assert.equal(next.defaultPrevented, false, "the next Enter keeps its normal (newline) behaviour");
	});

	it("multi Other: Enter while dictating only stops the run; the tail lands in the box and the next Enter adds the one entry", async () => {
		await mount(new CardClient({ tool: "ask_user_question", fields: [{ id: "envs", kind: "multi", label: "Which?", allowOther: true, options: [{ label: "dev", value: "dev" }] }] }));
		const other = q('[data-testid="card-other"]') as HTMLInputElement;
		await focus(other);
		const ws = await recording("canary ring");
		// Add is still disabled (the transcript is deferred until the run ends); the first Enter only stops the run.
		await press(other, { key: "Enter" });
		await closeSocket(ws);
		await settle();
		assert.equal(document.querySelectorAll('[data-testid="card-option"][data-custom="true"]').length, 0, "first Enter adds nothing");
		assert.equal(other.value, "canary ring");
		await press(other, { key: "Enter" });
		await settle();
		const rows = [...document.querySelectorAll('[data-testid="card-option"][data-custom="true"]')];
		assert.equal(rows.length, 1);
		assert.match(rows[0]!.textContent!, /canary ring/);
		assert.equal(other.value, "", "no pending text left to become a second entry");
		await click(q('[data-testid="card-submit"]')!);
		await settle();
		const answers = posts.filter((p) => p.url.includes("/cards/"));
		assert.equal(answers.length, 1);
		assert.deepEqual(answers[0]!.body.answers.envs, { value: ["canary ring"], other: ["canary ring"] });
	});

	it("Enter while busy and dictating stops the run and fills the field without steering; the next Enter steers (the button stays Stop)", async () => {
		await mount(new CardClient(null), { inFlight: true });
		const ws = await recording("spoken steer");
		assert.equal(document.querySelector('[data-testid="composer"] button[aria-label="Stop"]')?.getAttribute("aria-label"), "Stop");
		await press(composer(), { key: "Enter" });
		await closeSocket(ws);
		await settle();
		assert.equal(posts.filter((p) => p.url.includes("/submit")).length, 0, "first press does not steer");
		assert.equal(composer().value, "spoken steer");
		await press(composer(), { key: "Enter" });
		await settle();
		assert.equal(posts.filter((p) => p.url.includes("abort")).length, 0, "no abort");
		const sent = posts.filter((p) => p.url.includes("/submit"));
		assert.equal(sent.length, 1);
		assert.match(JSON.stringify(sent[0]!.body), /spoken steer/);
	});

	it("clicking Stop while busy and dictating aborts the turn", async () => {
		await mount(new CardClient(null), { inFlight: true });
		await recording("ignored");
		await act(async () => {
			composer().closest("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
		});
		assert.equal(posts.filter((p) => p.url.includes("abort")).length, 1);
	});

	it("an invalid multi Other tail (duplicates an option) aborts Submit: no POST, the error shows", async () => {
		await mount(new CardClient({ tool: "ask_user_question", fields: [{ id: "envs", kind: "multi", label: "Which?", allowOther: true, options: [{ label: "dev", value: "dev" }] }] }));
		const other = q('[data-testid="card-other"]') as HTMLInputElement;
		await focus(other);
		const ws = await recording("dev");
		await click(q('[data-testid="card-submit"]')!);
		await closeSocket(ws);
		await settle();
		assert.equal(posts.filter((p) => p.url.includes("/cards/")).length, 0);
		assert.equal(other.value, "dev");
		assert.ok(q('[data-testid="card-other-error"]'), "inline error stays");
	});
});
