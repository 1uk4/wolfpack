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
	CustomEvent: dom.window.CustomEvent,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0),
	cancelAnimationFrame: (id: number) => clearTimeout(id),
	ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
	getComputedStyle: () => ({ animationName: "none" }),
});

const { KeyboardShortcuts } = await import("../components/keyboard-shortcuts.tsx");
const { SettingsDialogProvider } = await import("../components/settings/settings-dialog.tsx");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { ThreadChat } = await import("../components/thread-chat.tsx");

let root: Root | null = null;
const assistant = (id: string, thinking: string, text: string) =>
	({
		id,
		role: "assistant",
		content: [{ type: "thinking", thinking }, { type: "text", text }],
		api: "x", provider: "x", model: "x", stopReason: "stop", timestamp: 1,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	}) as never;

const triggers = () => [...document.querySelectorAll("button[aria-expanded]")] as HTMLElement[];
const trigger = (i: number) => triggers()[i]!;
const expanded = () => triggers().map((b) => b.getAttribute("aria-expanded"));

async function mount() {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => {
		root!.render(
			<AppRouterContext.Provider value={{ push() {} } as never}>
			<SettingsDialogProvider>
				<ThreadChat wolf="w" slug="s" threadId="t1" title="T" initialMessages={[assistant("a1", "first", "x"), assistant("a2", "second", "y")]} />
				<KeyboardShortcuts />
			</SettingsDialogProvider>
			</AppRouterContext.Provider>,
		);
	});
}
const key = () =>
	act(async () => {
		window.dispatchEvent(Object.assign(new dom.window.Event("keydown"), { key: "t", metaKey: true }));
	});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const click = (el: HTMLElement) =>
	act(async () => {
		el.dispatchEvent(Object.assign(new dom.window.Event("click", { bubbles: true, cancelable: true }), { detail: 1 }));
	});

describe("ThreadChat thinking blocks (real mount)", () => {
	it("renders the reasoning blocks collapsed", async () => {
		await mount();
		assert.deepEqual(expanded(), ["false", "false"]);
	});

	it("the real ⌘T keydown opens every block, then collapses, then reopens", async () => {
		await mount();
		await key();
		assert.deepEqual(expanded(), ["true", "true"]);
		await key();
		assert.deepEqual(expanded(), ["false", "false"]);
		await key();
		assert.deepEqual(expanded(), ["true", "true"]);
	});

	it("clicking a header toggles just that block; the next ⌘T stomps it", async () => {
		await mount();
		await click(trigger(0));
		assert.deepEqual(expanded(), ["true", "false"]);
		await click(trigger(0));
		assert.deepEqual(expanded(), ["false", "false"]);
		await click(trigger(1));
		assert.deepEqual(expanded(), ["false", "true"]);
		await key(); // first global toggle opens all
		assert.deepEqual(expanded(), ["true", "true"]);
		await click(trigger(1));
		assert.deepEqual(expanded(), ["true", "false"]);
		await key(); // allOpen true -> false
		assert.deepEqual(expanded(), ["false", "false"]);
	});

	it("the header trigger spans the whole row", async () => {
		await mount();
		assert.match(trigger(0).getAttribute("class") ?? "", /\bw-full\b/);
		assert.match(trigger(0).textContent ?? "", /AGENT/);
	});
});
