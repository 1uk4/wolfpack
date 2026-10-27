/**
 * ThreadChat dictation wiring (real mount; fake Deepgram socket + mic, no real audio): the bar renders in the dock,
 * finishing inserts into the composer, a focused card field (free-text / Other) takes over as the target, focus back
 * on the composer hands it back, Esc cancels, and a missing key shows the keyless hint.
 * (header of the card test follows)
 * ThreadChat answering a wolf's card (real mount): the pending card renders inline, Submit goes through the console's
 * server layer (createThreadApi over a mock ConsoleClient), the answered card replaces the form, and the next turn's
 * text streams in. Seam 2 of the ask-card ticket.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { after, afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
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
	state = "running";
	destination = {};
	audioWorklet = { addModule: async () => {} };
	createMediaStreamSource() {
		return new FakeNode();
	}
	async resume() {}
}
let tokenStatus = 200;
Object.assign(globalThis, { WebSocket: FakeWS, AudioContext: FakeCtx, AudioWorkletNode: FakeNode });
Object.defineProperty(globalThis, "navigator", {
	configurable: true,
	value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
});

const realFetch = globalThis.fetch;
let root: Root | null = null;

async function mount(client: CardClient) {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		if (String(input).includes("/api/stt/token")) {
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
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
				<SettingsDialogProvider>
					<MemoryEventsProvider connect={inertSource}>
						<ThreadChat
							wolf="1uk4"
							slug="home"
							threadId={FIXTURE_THREAD.id}
							title="Home"
							initialMessages={threadMessagesToNative(detail.messages)}
							initialCards={cardsOfThread(detail)}
						/>
					</MemoryEventsProvider>
				</SettingsDialogProvider>
			</AppRouterContext.Provider>,
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

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	tokenStatus = 200;
	FakeWS.last = null;
	document.body.innerHTML = "";
});

describe("ThreadChat dictation", () => {
	it("renders the dictation bar in the dock; recording swaps in the meter", async () => {
		await mount(new CardClient(null));
		assert.ok(q('[data-testid="dictation-slot"] [data-testid="dictation-toggle"]'));
		assert.equal(q('[data-testid="dictation-bar"]'), null);
		await click(toggle());
		assert.ok(q('[data-testid="dictation-bar"]'), "meter shows from the click");
		await act(async () => window.dispatchEvent(new CustomEvent("lh:kbd-cancel-dictation")));
		assert.equal(q('[data-testid="dictation-bar"]'), null);
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
		assert.equal(q('[data-testid="card-submit"]')!.hasAttribute("disabled"), false);
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
});
