/**
 * The send button is protected from double clicks: while a send is in flight (or the host says the thread is graduating,
 * shipping, ...) it is disabled with a spinner, a second submit does not send again, and it re-enables when the send settles.
 * Seam: the real Composer, driven through its rendered form handler.
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
	HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});

const { Composer } = await import("../../../components/composer/composer.tsx");

let root: Root | null = null;
const host = document.createElement("div");
document.body.appendChild(host);
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
});
const props = (el: Element, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];
const button = () => document.querySelector('button[type="submit"]') as HTMLButtonElement;
const submit = () => act(async () => void props(document.querySelector('[data-testid="composer"]')!, "onSubmit")({ preventDefault() {} }));

async function mount(onSend: () => unknown, sending?: boolean) {
	await act(async () => {
		root ??= createRoot(host);
		root.render(<Composer busy={false} value="hi" onChange={() => {}} onSend={onSend as () => void} onStop={() => {}} canSend sending={sending} />);
	});
}

describe("composer send button while a send is in flight", () => {
	it("ignores a second submit, shows a disabled spinner, and re-enables when the send settles", async () => {
		let calls = 0;
		let finish!: () => void;
		await mount(() => (calls++, new Promise<void>((r) => (finish = r))));
		await submit();
		await submit();
		assert.equal(calls, 1);
		assert.equal(button().disabled, true);
		assert.equal(button().getAttribute("aria-busy"), "true");
		await act(async () => finish());
		assert.equal(button().disabled, false);
		await submit();
		assert.equal(calls, 2);
	});

	it("is disabled while the host reports a longer event (graduating, shipping)", async () => {
		let calls = 0;
		await mount(() => void calls++, true);
		assert.equal(button().disabled, true);
		await submit();
		assert.equal(calls, 0);
	});
});
