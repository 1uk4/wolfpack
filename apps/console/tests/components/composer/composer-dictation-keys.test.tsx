/**
 * While dictation runs (recording or flushing its last words), neither Enter nor the button may stop the wolf's turn.
 * Seam: the real Composer, driven through its rendered form and textarea handlers.
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

async function mount(phase: "dictating" | "finishing", enterSends: boolean) {
	const calls = { stop: 0, send: 0 };
	await act(async () => {
		root ??= createRoot(host);
		root.render(
			<Composer
				busy
				value=""
				onChange={() => {}}
				onSend={() => void calls.send++}
				onStop={() => void calls.stop++}
				canSend={false}
				enterSends={enterSends}
				{...(phase === "dictating" ? { dictating: true } : { finishing: true })}
			/>,
		);
	});
	const press = () => {
		act(() => void props(document.querySelector("textarea")!, "onKeyDown")({ key: "Enter", shiftKey: false, metaKey: false, ctrlKey: false, preventDefault() {} }));
		act(() => void props(document.querySelector('[data-testid="composer"]')!, "onSubmit")({ preventDefault() {} }));
	};
	return { calls, press };
}

describe("Enter and the main button during dictation with a wolf turn running", () => {
	for (const enterSends of [false, true]) {
		it(`recording: they only finish the dictation, never stop the wolf (enterSends=${enterSends})`, async () => {
			const { calls, press } = await mount("dictating", enterSends);
			press();
			assert.deepEqual(calls, { stop: 0, send: 2 });
		});
		it(`flushing the last words: they do nothing at all (enterSends=${enterSends})`, async () => {
			const { calls, press } = await mount("finishing", enterSends);
			press();
			assert.deepEqual(calls, { stop: 0, send: 0 });
		});
	}
});
