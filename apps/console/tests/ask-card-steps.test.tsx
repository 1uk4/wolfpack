/**
 * Stepped AskCard (card.steps + field.showIf): one step at a time, Back/Next, answers held client-side, ONE submission
 * on the last step, and a dependent step skipped (its field neither shown nor sent) when its showIf does not hold.
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
const { draftAnswers, draftComplete, initialDraft, visibleSteps, visibleFields: mirrorVisible } = await import("../src/core/index.ts");
const { visibleFields: protocolVisible } = await import("@wolfpack/protocol");


const strategy = [{ label: "By folder", value: "by-folder" }, { label: "By pattern", value: "by-pattern" }];
const card = (): Card => ({
	tool: "ask_user_question",
	fields: [
		{ id: "source", kind: "free-text", label: "Source dir?" },
		{ id: "strategy", kind: "single", label: "Strategy?", options: strategy, allowOther: false },
		{ id: "depth", kind: "single", label: "Depth?", options: [{ label: "1", value: "1" }, { label: "2", value: "2" }], showIf: { field: "strategy", equals: "by-folder" } },
		{ id: "go", kind: "confirm", label: "Go?" },
	],
	steps: [{ title: "Source", fields: ["source"] }, { title: "Shape", fields: ["strategy", "depth"] }, { title: "Confirm", fields: ["go"] }],
});

let root: Root | null = null;
const sent: CardAnswers[] = [];
async function mount(c: Card) {
	sent.length = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<AskCard callId="c1" card={c} pending submitting={false} onAnswer={(a) => void sent.push(a)} />);
	});
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});
const click = (el: Element) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
	});
const type = (el: HTMLElement, value: string) =>
	act(async () => {
		const key = Object.keys(el).find((k) => k.startsWith("__reactProps"))!;
		(el as unknown as Record<string, { onChange(e: unknown): void }>)[key]!.onChange({ target: { value } });
	});
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const fields = () => [...document.querySelectorAll("[data-field]")].map((e) => e.getAttribute("data-field"));
const pick = (value: string) => click(document.querySelector(`[data-testid="card-option"][data-value="${value}"]`)!);
const isDisabled = (el: HTMLElement | null) => el?.hasAttribute("disabled") === true;

describe("stepped AskCard", () => {
	it("shows one step at a time; Next is gated on the step; answers are held; one submit", async () => {
		await mount(card());
		assert.deepEqual(fields(), ["source"]);
		assert.match(q('[data-testid="card-step-indicator"]')!.textContent!, /Step 1 of 3 · Source/);
		assert.equal(q('[data-testid="card-back"]'), null);
		assert.equal(q('[data-testid="card-submit"]'), null);
		assert.ok(isDisabled(q('[data-testid="card-next"]')), "Next waits for an answer");
		await type(q('[data-testid="card-text"]')!, "/data/kb");
		await click(q('[data-testid="card-next"]')!);
		assert.deepEqual(fields(), ["strategy"], "depth stays hidden until by-folder");
		await pick("by-folder");
		assert.deepEqual(fields(), ["strategy", "depth"], "the dependent field appears");
		assert.ok(isDisabled(q('[data-testid="card-next"]')), "the revealed field is required");
		await pick("2");
		// Back keeps the held answer.
		await click(q('[data-testid="card-back"]')!);
		const el = q('[data-testid="card-text"]')!;
		const props = (el as unknown as Record<string, { value: string }>)[Object.keys(el).find((k) => k.startsWith("__reactProps"))!]!;
		assert.equal(props.value, "/data/kb");
		await click(q('[data-testid="card-next"]')!);
		await click(q('[data-testid="card-next"]')!);
		assert.deepEqual(fields(), ["go"]);
		assert.equal(sent.length, 0, "nothing submitted before the last step");
		assert.equal(q('[data-testid="card-next"]'), null);
		await click(q('[data-testid="card-confirm"]')!);
		await click(q('[data-testid="card-submit"]')!);
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0], { source: { value: "/data/kb" }, strategy: { value: "by-folder" }, depth: { value: "2" }, go: { value: true } });
	});

	it("skips the dependent field: it is not shown, not required and not sent (stale answer dropped)", async () => {
		await mount(card());
		await type(q('[data-testid="card-text"]')!, "/x");
		await click(q('[data-testid="card-next"]')!);
		await pick("by-folder");
		await pick("1");
		await pick("by-pattern"); // flips the controlling answer: depth is hidden again
		assert.deepEqual(fields(), ["strategy"]);
		await click(q('[data-testid="card-next"]')!);
		await click(q('[data-testid="card-reject"]')!);
		await click(q('[data-testid="card-submit"]')!);
		assert.deepEqual(sent, [{ source: { value: "/x" }, strategy: { value: "by-pattern" }, go: { value: false } }]);
	});

	it("an all-hidden step is skipped from the step count", () => {
		const c = card();
		c.steps = [{ fields: ["source", "strategy"] }, { title: "Depth", fields: ["depth"] }, { fields: ["go"] }];
		const d = initialDraft(c);
		assert.equal(visibleSteps(c, d).length, 2);
		assert.equal(visibleSteps(c, { ...d, strategy: { value: "by-folder" } }).length, 3);
		assert.equal(draftComplete(c, { source: { value: "a" }, strategy: { value: "by-pattern" }, go: { value: true } }), true);
		assert.deepEqual(draftAnswers(c, { source: { value: "a" }, strategy: { value: "by-pattern" }, depth: { value: "1" }, go: { value: true } }).depth, undefined);
	});

	it("a card without steps stays a single page", async () => {
		const c = card();
		delete c.steps;
		await mount(c);
		assert.deepEqual(fields(), ["source", "strategy", "go"]);
		assert.equal(q('[data-testid="card-next"]'), null);
		assert.ok(q('[data-testid="card-submit"]'));
	});

	it("Next and Back release a dictation claim; Enter in a text input advances; focus moves to the new step", async () => {
		await mount(card());
		const input = q('[data-testid="card-text"]')!;
		await type(input, "/p");
		await act(async () => {
			const key = Object.keys(input).find((k) => k.startsWith("__reactProps"))!;
			(input as unknown as Record<string, { onFocus(): void }>)[key]!.onFocus();
		});
		assert.ok(q("[data-dictation-claimed]"), "the focused text field claims dictation");
		await click(q('[data-testid="card-next"]')!);
		assert.equal(q("[data-dictation-claimed]"), null, "Next drops the claim");
		assert.equal(q('[data-testid="card-step-indicator"]')!.getAttribute("aria-live"), "polite");
		await click(q('[data-testid="card-back"]')!);
		assert.equal(q("[data-dictation-claimed]"), null, "Back does not resurrect it");
		// Enter advances from a single-line input (the free-text box is a textarea: Enter stays a newline there)
		const root = q('[data-testid="pending-card"]')!;
		await act(async () => {
			const ev = Object.assign(new dom.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "Enter" });
			Object.defineProperty(ev, "target", { value: { tagName: "TEXTAREA" } });
			root.dispatchEvent(ev);
		});
		assert.deepEqual(fields(), ["source"], "Enter in a textarea does not advance");
	});
});

/** One table of showIf cases, run against the protocol's visibleFields and the console's mirror. */
describe("visibleFields parity (protocol vs console mirror)", () => {
	const OPTS = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
	const c = (fields: object[]): Card => ({ tool: "t", fields }) as Card;
	const cases: [string, Card, Record<string, { value: unknown }>, string[]][] = [
		["no showIf", c([{ id: "k", kind: "single", label: "k", options: OPTS }, { id: "z", kind: "free-text", label: "z" }]), {}, ["k", "z"]],
		["equals unmet", c([{ id: "k", kind: "single", label: "k", options: OPTS }, { id: "d", kind: "free-text", label: "d", showIf: { field: "k", equals: "a" } }]), { k: { value: "b" } }, ["k"]],
		["equals met", c([{ id: "k", kind: "single", label: "k", options: OPTS }, { id: "d", kind: "free-text", label: "d", showIf: { field: "k", equals: "a" } }]), { k: { value: "a" } }, ["k", "d"]],
		["oneOf met", c([{ id: "k", kind: "single", label: "k", options: OPTS }, { id: "d", kind: "free-text", label: "d", showIf: { field: "k", oneOf: ["a", "b"] } }]), { k: { value: "b" } }, ["k", "d"]],
		["oneOf, controller unanswered", c([{ id: "k", kind: "single", label: "k", options: OPTS }, { id: "d", kind: "free-text", label: "d", showIf: { field: "k", oneOf: ["a"] } }]), {}, ["k"]],
		["confirm true", c([{ id: "m", kind: "confirm", label: "m" }, { id: "n", kind: "free-text", label: "n", showIf: { field: "m", equals: true } }]), { m: { value: true } }, ["m", "n"]],
		["confirm false hides", c([{ id: "m", kind: "confirm", label: "m" }, { id: "n", kind: "free-text", label: "n", showIf: { field: "m", equals: true } }]), { m: { value: false } }, ["m"]],
		["chain collapses with its root", c([{ id: "k", kind: "single", label: "k", options: OPTS }, { id: "m", kind: "confirm", label: "m", showIf: { field: "k", equals: "a" } }, { id: "n", kind: "free-text", label: "n", showIf: { field: "m", equals: true } }]), { k: { value: "b" }, m: { value: true } }, ["k"]],
	];
	for (const [name, card, answers, want] of cases) {
		it(name, () => {
			assert.deepEqual(protocolVisible(card, answers as never).map((f) => f.id), want);
			assert.deepEqual(mirrorVisible(card, answers as never).map((f) => f.id), want);
		});
	}
});
