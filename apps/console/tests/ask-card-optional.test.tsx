/**
 * AskCard optional fields (Submit gating, empty submission, "(optional)" label), hidden showIf fields never blocking Submit,
 * and whole-row clicks on option rows.
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


const opt = [{ label: "A", value: "a" }, { label: "B", value: "b" }];
const optionalCard = (extra: Partial<Card> = {}): Card => ({
	tool: "ask_user_question",
	fields: [
		{ id: "t", kind: "free-text", label: "Text?", optional: true },
		{ id: "s", kind: "single", label: "Single?", options: opt, allowOther: false, optional: true },
		{ id: "m", kind: "multi", label: "Multi?", options: opt, min: 1, max: 1, optional: true },
		{ id: "c", kind: "confirm", label: "Confirm?", optional: true },
	],
	...extra,
});
const submitBtn = () => q('[data-testid="card-submit"]');

describe("optional fields", () => {
	it("Submit is enabled with every optional field blank; the answers carry them empty (confirm omitted)", async () => {
		await mount(optionalCard());
		assert.ok(!isDisabled(submitBtn()));
		assert.equal(document.querySelectorAll('[data-testid="card-optional"]').length, 4);
		assert.match(q('[data-testid="card-optional"]')!.textContent!, /\(optional\)/);
		await click(submitBtn()!);
		assert.deepEqual(sent, [{ t: { value: "" }, s: { value: "" }, m: { value: [] } }]);
	});

	it("a required field renders no (optional) and still blocks; min/max apply once an optional multi is touched", async () => {
		await mount({ tool: "x", fields: [{ id: "r", kind: "free-text", label: "Req?" }, { id: "m", kind: "multi", label: "M?", options: opt, min: 2, optional: true }] });
		assert.equal(document.querySelectorAll('[data-testid="card-optional"]').length, 1);
		assert.ok(isDisabled(submitBtn()));
		await type(q('[data-testid="card-text"]')!, "x");
		assert.ok(!isDisabled(submitBtn()));
		await pick("a");
		assert.ok(isDisabled(submitBtn()), "1 picked < min 2");
		await pick("b");
		assert.ok(!isDisabled(submitBtn()));
	});

	it("an answered optional field is sent as given", async () => {
		await mount(optionalCard());
		await type(q('[data-testid="card-text"]')!, " hi ");
		await click(document.querySelector('[data-field="s"] [data-value="b"]')!);
		await click(document.querySelector('[data-field="m"] [data-value="b"]')!);
		await click(q('[data-testid="card-confirm"]')!);
		await click(submitBtn()!);
		assert.deepEqual(sent[0], { t: { value: "hi" }, s: { value: "b" }, m: { value: ["b"] }, c: { value: true } });
	});

	it("stepped: Next is enabled over a blank optional step", async () => {
		await mount(optionalCard({ steps: [{ fields: ["t", "s"] }, { fields: ["m", "c"] }] }));
		assert.ok(!isDisabled(q('[data-testid="card-next"]')));
		await click(q('[data-testid="card-next"]')!);
		assert.ok(!isDisabled(submitBtn()));
	});
});

describe("hidden showIf fields never block Submit", () => {
	const gated = (steps: boolean): Card => ({
		tool: "x",
		fields: [
			{ id: "mode", kind: "single", label: "Mode?", options: opt, allowOther: false },
			{ id: "extra", kind: "free-text", label: "Extra?", showIf: { field: "mode", equals: "a" } },
		],
		...(steps ? { steps: [{ fields: ["mode"] }, { fields: ["extra"] }] } : {}),
	});
	for (const steps of [false, true]) {
		it(steps ? "stepped" : "single page", async () => {
			await mount(gated(steps));
			await pick("b");
			if (steps) assert.equal(q('[data-testid="card-next"]'), null, "the hidden step vanishes");
			assert.ok(!isDisabled(submitBtn()));
			await click(submitBtn()!);
			assert.deepEqual(sent, [{ mode: { value: "b" } }]);
		});
	}
});

describe("whole-row clicks", () => {
	it("clicking the label of a multi / single / confirm row selects it", async () => {
		await mount({
			tool: "x",
			fields: [
				{ id: "m", kind: "multi", label: "M?", options: opt },
				{ id: "s", kind: "single", label: "S?", options: opt, allowOther: false },
				{ id: "c", kind: "confirm", label: "C?" },
			],
		});
		const row = (sel: string) => q(sel)!;
		const labelOf = (b: HTMLElement) => b.querySelector("span:not([aria-hidden]) *, span:not([aria-hidden])") ?? b;
		const m = document.querySelector('[data-testid="card-multi"] [data-value="a"]') as HTMLElement;
		await click(labelOf(m)); // bubbles to the row button
		assert.equal(m.getAttribute("aria-pressed"), "true");
		assert.equal(m.querySelector('[data-testid="card-indicator"]')!.getAttribute("data-on"), "true");
		await click(labelOf(m));
		assert.equal(m.getAttribute("aria-pressed"), "false");
		const s = document.querySelector('[data-field="s"] [data-value="b"]') as HTMLElement;
		await click(labelOf(s));
		assert.equal(s.getAttribute("aria-pressed"), "true");
		const c = row('[data-testid="card-reject"]');
		await click(labelOf(c));
		assert.equal(c.getAttribute("aria-pressed"), "true");
	});
});

describe("un-picking optional single / confirm", () => {
	const card2 = (optional: boolean): Card => ({
		tool: "x",
		fields: [
			{ id: "s", kind: "single", label: "S?", options: opt, allowOther: false, default: "a", ...(optional ? { optional } : {}) },
			{ id: "c", kind: "confirm", label: "C?", default: true, ...(optional ? { optional } : {}) },
		],
	});
	it("clicking the selected option clears it, even a default; an optional confirm skipped while others are answered", async () => {
		await mount(card2(true));
		const s = document.querySelector('[data-field="s"] [data-value="a"]') as HTMLElement;
		assert.equal(s.getAttribute("aria-pressed"), "true");
		await click(s);
		assert.equal(s.getAttribute("aria-pressed"), "false");
		await click(q('[data-testid="card-confirm"]')!);
		assert.equal(q('[data-testid="card-confirm"]')!.getAttribute("aria-pressed"), "false");
		await click(document.querySelector('[data-field="s"] [data-value="b"]')!);
		await click(submitBtn()!);
		assert.deepEqual(sent, [{ s: { value: "b" } }]);
	});
	it("required fields keep their selection on a second click", async () => {
		await mount(card2(false));
		const s = document.querySelector('[data-field="s"] [data-value="a"]') as HTMLElement;
		await click(s);
		assert.equal(s.getAttribute("aria-pressed"), "true");
		await click(q('[data-testid="card-confirm"]')!);
		assert.equal(q('[data-testid="card-confirm"]')!.getAttribute("aria-pressed"), "true");
	});
});
