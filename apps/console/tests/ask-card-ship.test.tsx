/**
 * The task_done ship card with several tasks: one multi field, one checkbox per task labelled with title and id, all ticked.
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

const ships: Card = {
	tool: "task_done",
	fields: [
		{
			id: "ships",
			kind: "multi",
			label: "Ship these 3 tasks?",
			options: [
				{ value: "work-1", label: "Fix login (work-1)" },
				{ value: "work-2", label: "Write docs (work-2)" },
				{ value: "work-3", label: "Tidy CI (work-3)" },
			],
			default: ["work-1", "work-2", "work-3"],
			min: 1,
		},
	] as Card["fields"],
};

let root: Root | null = null;
const sent: CardAnswers[] = [];
async function mount(card: Card, props: Partial<React.ComponentProps<typeof AskCard>> = {}) {
	sent.length = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<AskCard callId="c1" card={card} pending submitting={false} onAnswer={(a) => void sent.push(a)} {...props} />);
	});
}
const click = (el: Element) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
	});
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const submit = () => document.querySelector('[data-testid="card-submit"]') as HTMLElement;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("AskCard: multi ship card (task_done)", () => {
	it("lists every task by title and id, all ticked, no Other", async () => {
		await mount(ships);
		const rows = qa('[data-testid="card-option"]');
		assert.equal(rows.length, 3);
		assert.deepEqual(rows.map((r) => r.getAttribute("aria-pressed")), ["true", "true", "true"]);
		assert.match(rows[0]!.textContent ?? "", /Fix login \(work-1\)/);
		assert.match(rows[2]!.textContent ?? "", /Tidy CI \(work-3\)/);
		assert.equal(document.querySelector('[data-testid="card-other"]'), null);
		assert.match(document.body.textContent ?? "", /Ship these 3 tasks\?/);
	});

	it("unticking one and submitting sends only the rest; nothing is sent before Submit", async () => {
		await mount(ships);
		assert.deepEqual(sent, []);
		await click(qa('[data-testid="card-option"]')[1]!);
		await click(submit());
		assert.deepEqual(sent, [{ ships: { value: ["work-1", "work-3"] } }]);
	});

	it("unticking all blocks Submit (min 1)", async () => {
		await mount(ships);
		for (const r of qa('[data-testid="card-option"]')) await click(r);
		assert.equal(submit().hasAttribute("disabled"), true);
	});
});
