import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "../components/ai-elements/reasoning.tsx";
import { useAllThinkingToggle } from "../components/thinking-toggle.ts";
import { kbdEventForAction } from "../src/core/keyboard.ts";

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
	getComputedStyle: () => ({ animationName: "none" }),
});

let root: Root | null = null;

// Mirrors thread-chat's reasoning wiring: the hook's state keys + defaults
// every block.
function Harness() {
	const { allOpen, epoch } = useAllThinkingToggle();
	return (
		<div>
			{[0, 1].map((i) => (
				<Reasoning key={`${i}:${epoch}`} defaultOpen={allOpen ?? undefined}>
					<ReasoningTrigger />
					<ReasoningContent>{`thought ${i}`}</ReasoningContent>
				</Reasoning>
			))}
		</div>
	);
}

const expanded = () => [...document.querySelectorAll("button[aria-expanded]")].map((b) => b.getAttribute("aria-expanded"));
const fire = () => act(async () => { window.dispatchEvent(new CustomEvent(kbdEventForAction("toggle-user-thinking"))); });

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

describe("thread ⌘T thinking toggle", () => {
	it("opens every reasoning block, then collapses them all, then reopens", async () => {
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => { root!.render(<Harness />); });
		assert.deepEqual(expanded(), ["false", "false"], "collapsed by default");
		await fire();
		assert.deepEqual(expanded(), ["true", "true"]);
		await fire();
		assert.deepEqual(expanded(), ["false", "false"]);
		await fire();
		assert.deepEqual(expanded(), ["true", "true"]);
	});
});
