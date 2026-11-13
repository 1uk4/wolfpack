/** Brief header, bullet clamp, OK acknowledge, and the field-kind registry (unknown kind falls back to free text, a registered dummy kind renders). */
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
const { AskCard } = await import("../../../components/ask/ask-card.tsx");
const { registerFieldRenderer, unregisterFieldRenderer } = await import("../../../components/ask/card-fields/index.ts");


let root: Root | null = null;
const sent: CardAnswers[] = [];
async function mount(c: Card, answer?: CardAnswers) {
	sent.length = 0;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(<AskCard callId="c1" card={c} {...(answer ? { answer } : {})} pending={!answer} submitting={false} onAnswer={(a) => void sent.push(a)} />);
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
const q = (sel: string) => document.querySelector(sel);
const all = (sel: string) => [...document.querySelectorAll(sel)];

describe("brief card", () => {
	it("renders the headline, bullets and the thread pointer", async () => {
		await mount({ tool: "brief", fields: [{ id: "q1", kind: "confirm", label: "Ship?" }], brief: { headline: "Ready to ship", context: ["tests pass", "docs updated"], more: "see thread" } });
		assert.equal(q('[data-testid="brief-headline"]')?.textContent, "Ready to ship");
		assert.deepEqual(all('[data-testid="brief-bullet"]').map((b) => b.getAttribute("data-clamped")), [null, null]);
		assert.match(q('[data-testid="brief-more"]')?.textContent ?? "", /Open thread for more/);
	});
	it("clamps a long bullet behind a more toggle", async () => {
		await mount({ tool: "brief", fields: [], brief: { headline: "h", context: ["x".repeat(300)] } });
		assert.equal(q('[data-testid="brief-bullet"]')?.getAttribute("data-clamped"), "true");
		await click(q('[data-testid="brief-bullet-toggle"]')!);
		assert.equal(q('[data-testid="brief-bullet"]')?.getAttribute("data-clamped"), null);
	});
	it("zero questions shows OK, which acknowledges with an empty answer", async () => {
		await mount({ tool: "brief", fields: [], brief: { headline: "Done" } });
		const ok = q('[data-testid="card-submit"]')!;
		assert.equal(ok.textContent, "OK");
		await click(ok);
		assert.deepEqual(sent, [{}]);
	});
});

describe("legacy brief in history", () => {
	it("an answered brief card still renders read-only: headline, bullets and the recorded answer, no form", async () => {
		await mount(
			{ tool: "brief", fields: [{ id: "q1", kind: "confirm", label: "Ship?" }], brief: { headline: "Ready to ship", context: ["tests pass"] } },
			{ q1: { value: true } } as CardAnswers,
		);
		assert.equal(q('[data-testid="answered-card"]') !== null, true);
		assert.equal(q('[data-testid="brief-headline"]')?.textContent, "Ready to ship");
		assert.equal(q('[data-testid="brief-bullet"]')?.textContent?.includes("tests pass"), true);
	});
});

describe("field-kind registry", () => {
	it("an unknown kind renders as a free-text answer with the question shown", async () => {
		await mount({ tool: "brief", fields: [{ id: "n", kind: "slider", label: "How many?" } as never], brief: { headline: "h" } });
		assert.match(document.body.textContent ?? "", /How many\?/);
		assert.ok(q('[data-testid="card-text"]'));
	});
	it("a registered dummy kind renders its own control", async () => {
		registerFieldRenderer("slider", ({ field }) => <div data-testid="dummy-slider">{field.label}</div>);
		await mount({ tool: "brief", fields: [{ id: "n", kind: "slider", label: "Pick" } as never], brief: { headline: "h" } });
		assert.equal(q('[data-testid="dummy-slider"]')?.textContent, "Pick");
		unregisterFieldRenderer("slider");
	});
});
