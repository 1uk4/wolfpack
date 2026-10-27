/**
 * AskCard multi with allowOther: however a custom entry gets in (Add, Enter, Submit with pending text), it appears
 * exactly once in the answer and ticked options stay. Dictation into Other is covered in thread-chat-dictation.test.tsx.
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

type Card = import("@wolfpack/client").Card;
type CardAnswers = import("@wolfpack/client").CardAnswers;
const { AskCard } = await import("../components/ask-card.tsx");

const OPTS = [{ label: "Alpha", value: "a" }, { label: "Beta", value: "b" }];
const card: Card = { tool: "t", fields: [{ id: "m", kind: "multi", label: "Pick", options: OPTS, allowOther: true }] as Card["fields"] };

let root: Root | null = null;
const sent: CardAnswers[] = [];
async function mount() {
	sent.length = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<AskCard callId="c1" card={card} pending submitting={false} onAnswer={(a) => void sent.push(a)} />);
	});
}
const click = (el: Element) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
	});
const reactProps = (el: Element) => (el as unknown as Record<string, Record<string, ((e: unknown) => void) | undefined>>)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!]!;
const type = (value: string) =>
	act(async () => {
		reactProps(q('[data-testid="card-other"]')!).onChange!({ target: { value } });
	});
const enter = () =>
	act(async () => {
		reactProps(q('[data-testid="card-other"]')!).onKeyDown!({ key: "Enter", defaultPrevented: false, preventDefault() {} });
	});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const add = () => click(q('[data-testid="card-other-add"]')!);
const submit = () => click(q('[data-testid="card-submit"]')!);
const tick = (i: number) => click(qa('[data-testid="card-option"]')[i]!);
const MINE = { m: { value: ["a", "mine"], other: ["mine"] } };

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("AskCard multi Other: one custom entry is one entry", () => {
	it("(a) type, Add, Submit", async () => {
		await mount();
		await tick(0);
		await type("mine");
		await add();
		await submit();
		assert.deepEqual(sent, [MINE]);
	});

	it("(a2) type, Enter, Submit", async () => {
		await mount();
		await tick(0);
		await type("mine");
		await enter();
		await submit();
		assert.deepEqual(sent, [MINE]);
	});

	it("(b) type, Submit with the text still pending", async () => {
		await mount();
		await tick(0);
		await type("mine");
		await submit();
		assert.deepEqual(sent, [MINE]);
	});

	it("(b2) type, Add, type the same text again: refused, not doubled; Submit sends one", async () => {
		await mount();
		await tick(0);
		await type("mine");
		await add();
		await type("mine");
		assert.match(q('[data-testid="card-other-error"]')?.textContent ?? "", /already added/);
		await submit();
		assert.equal(sent.length, 0, "an invalid pending duplicate blocks Submit rather than sending twice");
	});

	it("(d) type, Add, type another: two distinct entries, ticked option kept", async () => {
		await mount();
		await tick(0);
		await type("mine");
		await add();
		await type("yours");
		await submit();
		assert.deepEqual(sent, [{ m: { value: ["a", "mine", "yours"], other: ["mine", "yours"] } }]);
	});

	it("only a custom entry (nothing else ticked) is sent once", async () => {
		await mount();
		await type("solo");
		await add();
		await submit();
		assert.deepEqual(sent, [{ m: { value: ["solo"], other: ["solo"] } }]);
	});

	it("a comma inside a custom entry stays one entry", async () => {
		await mount();
		await tick(0);
		await type("red, green");
		await submit();
		assert.deepEqual(sent, [{ m: { value: ["a", "red, green"], other: ["red, green"] } }]);
	});
});
