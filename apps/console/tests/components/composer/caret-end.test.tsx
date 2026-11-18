/**
 * Focus arriving from outside puts the caret at the END of a text field (composer, card answer field); a click in a field that
 * already has focus keeps the browser's own caret placement. Seam: the real Composer and CardTextInput.
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

const { Composer } = await import("../../../components/composer/composer.tsx");
const { CardTextInput } = await import("../../../components/ask/card-fields/shared.tsx");

let root: Root | null = null;
const host = document.createElement("div");
document.body.appendChild(host);
afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
});
const props = (el: Element, name: string) => (el as any)[Object.keys(el).find((k) => k.startsWith("__reactProps$"))!][name];

/** A textarea whose selection and focus the test can observe (linkedom has neither). */
function track(el: HTMLTextAreaElement) {
	const sel = { start: -1, end: -1 };
	let focused = false;
	Object.assign(el, {
		setSelectionRange: (s: number, e: number) => void Object.assign(sel, { start: s, end: e }),
		focus: () => void (focused = true),
	});
	Object.defineProperty(document, "activeElement", { configurable: true, get: () => (focused ? el : document.body) });
	return { sel, blur: () => void (focused = false), setFocused: () => void (focused = true) };
}
const mouseDown = (el: Element) => {
	let prevented = false;
	act(() => void props(el, "onMouseDown")({ preventDefault: () => void (prevented = true), currentTarget: el, target: el }));
	return prevented;
};

describe("the recording marker", () => {
	const mount = async (recording?: "live" | "stopping") => {
		await act(async () => {
			root ??= createRoot(host);
			root.render(<Composer busy={false} value="x" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend recording={recording} />);
		});
		return document.querySelector('[data-testid="recording-marker"]');
	};
	it("shows inside the field while the run is live, a spinner while it stops, and is gone after", async () => {
		assert.equal(await mount(), null);
		assert.equal((await mount("live"))?.getAttribute("data-state"), "live");
		assert.equal((await mount("stopping"))?.getAttribute("data-state"), "stopping");
		assert.equal(await mount(), null);
	});
});

describe("caret lands at the end when focus arrives from outside", () => {
	it("the composer: a click from outside focuses with the caret after the last character; a click while focused is left to the browser", async () => {
		await act(async () => {
			root = createRoot(host);
			root.render(<Composer busy={false} value="hello there" onChange={() => {}} onSend={() => {}} onStop={() => {}} canSend />);
		});
		const ta = document.querySelector("textarea") as HTMLTextAreaElement;
		(ta as any).value = "hello there";
		const t = track(ta);
		assert.equal(mouseDown(ta), true, "from outside: the browser's caret placement is replaced");
		assert.deepEqual(t.sel, { start: 11, end: 11 });
		t.setFocused();
		t.sel.start = -1;
		assert.equal(mouseDown(ta), false, "already focused: the click places the caret itself");
		assert.equal(t.sel.start, -1);
	});

	it("a card answer field: keyboard/programmatic focus puts the caret at the end", async () => {
		await act(async () => {
			root = createRoot(host);
			root.render(<CardTextInput testId="f" multiline value="typed answer" onChange={() => {}} />);
		});
		const ta = document.querySelector("textarea") as HTMLTextAreaElement;
		(ta as any).value = "typed answer";
		const t = track(ta);
		act(() => void props(ta, "onFocus")({ currentTarget: ta, target: ta }));
		assert.deepEqual(t.sel, { start: 12, end: 12 });
	});
});
