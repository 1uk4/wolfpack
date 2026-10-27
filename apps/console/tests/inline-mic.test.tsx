/**
 * Inline microphone: renders in every card text field (free-text, single Other, multi Other) and the prompt-override
 * editor; click claims that field and starts, a second click finishes, Esc cancels, a missing key leaves it idle.
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

const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AskCard } = await import("../components/ask-card.tsx");
const { OverrideTextarea } = await import("../components/settings/agent-section.tsx");
const { useDictation, joinDictation } = await import("../components/dictation.tsx");

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
globalThis.fetch = (async (input: RequestInfo | URL) => {
	if (String(input).includes("/api/stt/token")) {
		return tokenStatus === 200 ? new Response(JSON.stringify({ token: "tok" }), { status: 200 }) : new Response(JSON.stringify({ message: "no key" }), { status: tokenStatus });
	}
	return new Response("{}", { status: 404 });
}) as typeof fetch;

/** A page that owns the dictation hook (its composer fallback is a plain string) over the given children. */
function Page({ children }: { children: React.ReactNode }) {
	const [composer, setComposer] = React.useState("");
	useDictation({ append: (t) => setComposer((c) => joinDictation(c, t)) });
	return (
		<div>
			<div data-testid="composer-text">{composer}</div>
			{children}
		</div>
	);
}

const CARD = {
	tool: "ask_user_question",
	fields: [
		{ id: "why", kind: "free-text", label: "Why?" },
		{ id: "pick", kind: "single", label: "Which?", options: [{ label: "a", value: "a" }] },
		{ id: "many", kind: "multi", label: "Many?", options: [{ label: "x", value: "x" }], allowOther: true },
	],
} as never;

async function mount(children: React.ReactNode) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<SettingsDialogProvider>
				<Page>{children}</Page>
			</SettingsDialogProvider>,
		);
	});
}
const mountCard = () => mount(<AskCard card={CARD} callId="c1" pending submitting={false} onAnswer={() => {}} />);

const settle = (ms = 30) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const click = (el: Element) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
	});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const mics = () => [...document.querySelectorAll('[data-testid="inline-mic"]')] as HTMLElement[];
const cancel = () => act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-cancel-dictation")));
const kbdToggle = () => act(async () => void window.dispatchEvent(new CustomEvent("lh:kbd-toggle-dictation")));
Object.assign(dom.window.Element.prototype, { attachEvent() {}, detachEvent() {} });

/** Open the socket and deliver finals; the run stays live. */
async function live(...finals: string[]) {
	await settle();
	const ws = FakeWS.last!;
	await act(async () => ws.open());
	await act(async () => finals.forEach((f) => ws.final(f)));
	return ws;
}
const closeSocket = (ws: FakeWS) => act(async () => ws.emit("close", { code: 1000 }));

after(() => {
	globalThis.fetch = realFetch;
});
afterEach(async () => {
	await cancel();
	await act(async () => root?.unmount());
	root = null;
	tokenStatus = 200;
	FakeWS.last = null;
	document.body.innerHTML = "";
});

describe("inline mic in card text fields", () => {
	it("renders in the free-text, single Other and multi Other fields, idle and unpressed", async () => {
		await mountCard();
		const m = mics();
		assert.equal(m.length, 3);
		for (const b of m) {
			assert.equal(b.getAttribute("aria-label"), "Dictate");
			assert.equal(b.getAttribute("aria-pressed"), "false");
		}
		assert.ok(q('[data-testid="card-text"]')!.parentElement!.contains(m[0]!), "the mic sits in the field's wrapper");
	});

	it("click claims that field and starts; the second click finishes and the transcript lands in the field", async () => {
		await mountCard();
		const field = q('[data-testid="card-text"]') as HTMLTextAreaElement;
		await click(mics()[0]!);
		assert.ok(q("[data-dictation-claimed]"), "card claims the target");
		const ws = await live("because", "reasons");
		assert.equal(mics()[0]!.getAttribute("aria-pressed"), "true");
		assert.equal(mics()[0]!.getAttribute("aria-label"), "Stop dictating");
		assert.equal(mics()[1]!.getAttribute("aria-pressed"), "false", "other fields' mics are not listening");
		assert.equal(field.value, "", "nothing lands while recording");
		await click(mics()[0]!);
		await closeSocket(ws);
		await settle();
		assert.equal(field.value, "because reasons");
		assert.equal(mics()[0]!.getAttribute("aria-pressed"), "false");
		assert.equal(q('[data-testid="composer-text"]')!.textContent, "");
	});

	it("multi Other: a mic on another field retargets the live run; text goes into the pending typed text", async () => {
		await mountCard();
		await click(mics()[0]!);
		const ws = await live("first");
		await click(mics()[2]!);
		assert.equal(mics()[2]!.getAttribute("aria-pressed"), "true");
		assert.equal(mics()[0]!.getAttribute("aria-pressed"), "false");
		await click(mics()[2]!);
		await closeSocket(ws);
		await settle();
		const multiOther = document.querySelectorAll('[data-testid="card-other"]')[1] as HTMLInputElement;
		assert.equal(multiOther.value, "first");
		assert.equal((q('[data-testid="card-text"]') as HTMLTextAreaElement).value, "");
		assert.equal(q('[data-testid="card-other-add"]')!.hasAttribute("disabled"), false, "Add is enabled by the dictated text");
	});

	it("Esc cancels the run and discards the transcript", async () => {
		await mountCard();
		await click(mics()[0]!);
		await live("never lands");
		await cancel();
		await settle();
		assert.equal(mics()[0]!.getAttribute("aria-pressed"), "false");
		assert.equal((q('[data-testid="card-text"]') as HTMLTextAreaElement).value, "");
	});

	it("a missing Deepgram key leaves the mic idle (the Settings hint flow)", async () => {
		tokenStatus = 503;
		await mountCard();
		await click(mics()[0]!);
		await settle();
		assert.equal(mics()[0]!.getAttribute("aria-pressed"), "false");
	});
});

describe("inline mic in the prompt-override editor", () => {
	function Editor() {
		const [v, setV] = React.useState("");
		return <OverrideTextarea value={v} onChange={setV} micKey="prompt-override:test" />;
	}
	it("appends with joinDictation spacing, then releases the claim to the page composer", async () => {
		await mount(<Editor />);
		const ta = q("textarea") as HTMLTextAreaElement;
		assert.equal(mics().length, 1);
		await click(mics()[0]!);
		let ws = await live("be terse");
		assert.equal(mics()[0]!.getAttribute("aria-pressed"), "true");
		await click(mics()[0]!);
		await closeSocket(ws);
		await settle();
		assert.equal(ta.value, "be terse");
		// Claim released: ⌘D afterwards dictates to the page composer, not the editor.
		await kbdToggle();
		ws = await live("page text");
		await kbdToggle();
		await closeSocket(ws);
		await settle();
		assert.equal(q('[data-testid="composer-text"]')!.textContent, "page text");
		assert.equal(ta.value, "be terse");
		await click(mics()[0]!);
		ws = await live("and brief");
		await click(mics()[0]!);
		await closeSocket(ws);
		await settle();
		assert.equal(ta.value, "be terse and brief");
	});
});
