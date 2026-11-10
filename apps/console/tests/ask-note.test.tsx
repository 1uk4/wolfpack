/**
 * The questionnaire note and the "Send anyway?" confirm (work-wolfpack-ssPFrEw): the composer's text is the note, stored via
 * the note route (debounced), sent with Submit, or - with required questions open - sent as a normal chat message after a
 * inline confirm on the button. Seam: useAskSession + the real Composer mounted the way the hosts mount them, stubbed fetch.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
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

type PendingCard = import("@wolfpack/client").PendingCard;
const { useAskSession } = await import("../components/ask-session.ts");
const { Composer } = await import("../components/composer.tsx");

const card = {
	tool: "ask",
	paged: true,
	fields: [
		{ id: "q1", kind: "single", label: "Pick", options: [{ label: "Alpha", value: "a" }, { label: "Beta", value: "b" }] },
		{ id: "q2", kind: "free-text", label: "Why", optional: true },
	],
	steps: [{ fields: ["q1", "q2"] }],
} as unknown as PendingCard["card"];
const twoPages = {
	...card,
	fields: [card.fields[0]!, { id: "q2", kind: "free-text", label: "Why" }],
	steps: [{ fields: ["q1"] }, { fields: ["q2"] }],
} as unknown as PendingCard["card"];
const pending = (extra: Partial<PendingCard> = {}): PendingCard => ({ callId: "c1", threadId: "w/a", card, raisedAt: "2026-11-09T00:00:00+00:00", ...extra });

let calls: { method: string; url: string; body: any }[] = [];
let sent: string[] = [];
let sendOk = true;
let session: ReturnType<typeof useAskSession>;
const submitted: string[] = [];
const collapsed: { text: string }[] = [];
const realFetch = globalThis.fetch;
/** Holds the submit POST in flight until released. */
let submitGate: Promise<void> | undefined;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	calls.push({ method: String(init?.method), url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
	if (String(input).endsWith("/submit") && submitGate) await submitGate;
	return Response.json({ accepted: true, disposition: "started" });
}) as typeof fetch;

function Host({ pc }: { pc: PendingCard }) {
	session = useAskSession({ wolf: "w", slug: "a" }, pc, { onSubmitted: () => void submitted.push("s"), onRefetch: () => {}, onCollapse: (n) => void collapsed.push({ text: n.text }) });
	return (
		<>
			<Composer
				busy={false}
				value={session.note.text}
				onChange={session.setNoteText}
				onSend={() => session.press(async (t) => (sendOk ? (sent.push(t), true) : false))}
				onStop={() => {}}
				canSend={!session.action.disabled}
				sendLabel={session.action.label}
				alwaysLabel
				{...(session.action.armed ? { sendAriaLabel: session.action.ariaLabel, armed: { onCancel: session.disarm } } : {})}
			/>
			{session.action.hint ? <p data-testid="hint">{session.action.hint}</p> : null}
		</>
	);
}

let root: Root | null = null;
const host = document.createElement("div");
document.body.appendChild(host);
const render = (pc: PendingCard) => act(async () => { root ??= createRoot(host); root.render(<Host pc={pc} />); });
const q = (s: string) => document.querySelector(s) as HTMLElement | null;
const props = (el: Element, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
const type = (v: string) => act(async () => void props(q("textarea")!, "onChange")({ target: { value: v } }));
const press = () => act(async () => void props(q('form[data-testid="composer"]')!, "onSubmit")({ preventDefault() {} }));
const btn = () => q('button[type="submit"]')!;
const armed = () => btn().getAttribute("data-armed") === "true";
const esc = () => act(async () => void props(q('form[data-testid="composer"]')!, "onKeyDown")({ key: "Escape", preventDefault() {}, stopPropagation() {} }));
const noteText = () => (q("textarea") as HTMLTextAreaElement).value;
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	document.body.appendChild(host);
	calls = [];
	sent = [];
	sendOk = true;
	submitted.length = 0;
	collapsed.length = 0;
	submitGate = undefined;
});
const notePuts = () => calls.filter((c) => c.method === "PUT" && c.url.endsWith("/note"));

describe("questionnaire note", () => {
	it("typing a note stores it once through the note route after the debounce", async () => {
		await render(pending());
		await type("mind the budget");
		await type("mind the budget!");
		assert.equal(calls.length, 0);
		await wait(480);
		const puts = calls.filter((c) => c.url.endsWith("/cards/c1/note"));
		assert.equal(puts.length, 1);
		assert.equal(puts[0]!.method, "PUT");
		assert.deepEqual(puts[0]!.body, { text: "mind the budget!" });
	});

	it("an empty note with a required question open disables the button and names the question", async () => {
		await render(pending());
		assert.equal(props(btn(), "disabled"), true);
		assert.equal(q('[data-testid="hint"]')!.textContent, "Answer to continue: Q1");
	});

	it("Submit with every required question answered posts the answers and the note", async () => {
		await render(pending({ draft: { q1: { value: "b" } } as never }));
		await type("thanks");
		assert.equal(btn().textContent, "Submit");
		await press();
		const post = calls.find((c) => c.url.endsWith("/cards/c1/submit"))!;
		assert.equal(post.method, "POST");
		assert.deepEqual(post.body.answers, { q1: { value: "b" } });
		assert.deepEqual(post.body.note, { text: "thanks" });
		assert.deepEqual(submitted, ["s"]);
		assert.equal(noteText(), ""); // cleared after the submit
		await wait(480);
		assert.equal(notePuts().length, 0); // the submit carried the note: no debounced PUT follows
	});

	it("text typed while the submit is in flight is kept as a draft and saved, not cleared", async () => {
		await render(pending({ draft: { q1: { value: "b" } } as never }));
		await type("thanks");
		let release!: () => void;
		submitGate = new Promise<void>((r) => (release = r));
		await press();
		await type("thanks, and one more thing");
		release();
		await wait(0);
		assert.equal(noteText(), "thanks, and one more thing");
		await wait(480);
		assert.deepEqual(notePuts().map((c) => c.body), [{ text: "thanks, and one more thing" }]);
	});

	it("collapsing or flushing the note during an in-flight submit sends no note PUT", async () => {
		await render(pending({ draft: { q1: { value: "b" } } as never }));
		await type("thanks");
		submitGate = new Promise<void>(() => {});
		await press();
		await act(async () => void session.collapse());
		await wait(480);
		assert.equal(notePuts().length, 0);
	});

	it("Enter in the composer and a real form submit (the button's click) each arm, then send", async () => {
		await render(pending());
		await type("just ship it");
		// linkedom cannot carry a real keydown into React's textarea input polyfill, so Enter goes through the textarea's own handler.
		const enter = () => act(async () => void props(q("textarea")!, "onKeyDown")({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {} }));
		await enter();
		assert.equal(armed(), true);
		assert.deepEqual(sent, []);
		await enter();
		assert.deepEqual(sent, ["just ship it"]);
		await type("again");
		await act(async () => void q('form[data-testid="composer"]')!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true })));
		assert.equal(armed(), true);
	});

	it("the first press arms 'Send anyway?' without sending: label, hint and accessible name name the open questions", async () => {
		await render(pending());
		await type("just ship it");
		assert.equal(armed(), false);
		await press();
		assert.equal(armed(), true);
		assert.equal(btn().textContent, "Send anyway?");
		assert.equal(q('[data-testid="hint"]')!.textContent, "Q1 isn't answered");
		assert.equal(btn().getAttribute("aria-label"), "Send anyway? Q1 isn't answered");
		assert.equal(q('[data-testid="ask-keep-answering"]') !== null, true);
		assert.deepEqual(sent, []);
		assert.equal(noteText(), "just ship it");
	});

	it("the second press sends the note as one normal message and clears it", async () => {
		await render(pending());
		await type("just ship it");
		await press();
		await press();
		assert.deepEqual(sent, ["just ship it"]);
		assert.equal(noteText(), "");
		assert.equal(armed(), false);
	});

	it("a failed send disarms and keeps the note", async () => {
		await render(pending());
		await type("just ship it");
		sendOk = false;
		await press();
		await press();
		assert.deepEqual(sent, []);
		assert.equal(armed(), false);
		assert.equal(btn().textContent, "Submit");
		assert.equal(noteText(), "just ship it");
		assert.match(session.error ?? "", /Could not send/);
	});

	it("Esc and the cancel control disarm and keep the note", async () => {
		await render(pending());
		await type("just ship it");
		await press();
		await esc();
		assert.equal(armed(), false);
		await press();
		assert.equal(armed(), true);
		await act(async () => void props(q('[data-testid="ask-keep-answering"]')!, "onClick")({}));
		assert.equal(armed(), false);
		assert.deepEqual(sent, []);
		assert.equal(noteText(), "just ship it");
	});

	it("answering the missing question, or clearing the note, disarms", async () => {
		await render(pending());
		await type("just ship it");
		await press();
		await act(async () => session.set("q1", { value: "a" }));
		assert.equal(armed(), false);
		assert.equal(btn().textContent, "Submit");
		await act(async () => session.clear("q1"));
		await press();
		assert.equal(armed(), true);
		await type("");
		assert.equal(armed(), false);
	});

	it("changing page disarms", async () => {
		await render(pending({ card: twoPages }));
		await type("just ship it");
		await press();
		assert.equal(armed(), true);
		await act(async () => session.next());
		assert.equal(session.page, 1);
		assert.equal(armed(), false);
	});

	it("collapsing the sheet disarms", async () => {
		await render(pending());
		await type("just ship it");
		await press();
		await act(async () => void session.collapse());
		assert.equal(session.action.armed === true, false);
		await act(async () => session.setExpanded(true));
		assert.equal(session.action.armed === true, false);
	});

	it("collapsing hands the note to the host once and empties the session note", async () => {
		await render(pending());
		await type("keep this");
		await act(async () => void session.collapse());
		assert.deepEqual(collapsed, [{ text: "keep this" }]);
		assert.equal(session.expanded, false);
		assert.equal(session.note.text, "");
	});
});

process.on("exit", () => void (globalThis.fetch = realFetch));
