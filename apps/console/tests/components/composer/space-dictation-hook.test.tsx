/**
 * Seam: useSpaceDictation (the DOM wiring of the Space key), real mount with a fake clock. Catches: Space left armed after the window
 * loses focus (the release never arrives, the next press is swallowed), a hold-started run left running after a blur, and the autosend
 * event losing the thread it was started for. Misses: the real browser's focus events and the spoken audio.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
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
});

const { useSpaceDictation, setSpaceContext, DICTATION_AUTOSEND_EVENT } = await import("../../../components/composer/space-dictation.ts");

const calls: string[] = [];
let runningNow = false;
function Hook() {
	useSpaceDictation({
		enabled: true,
		isTarget: () => true,
		running: () => runningNow,
		toggle: () => {
			calls.push("toggle");
			runningNow = !runningNow;
		},
		finish: async () => void calls.push("finish"),
		cancel: () => {
			calls.push("cancel");
			runningNow = false;
		},
	});
	return null;
}

const key = (type: "keydown" | "keyup") => {
	const e = Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), { key: " ", code: "Space", repeat: false });
	dom.document.body.dispatchEvent(e);
};

let root: Root | null = null;
const sent: unknown[] = [];
const onAutosend = (e: Event) => void sent.push((e as CustomEvent).detail);
async function mountHook() {
	calls.length = 0;
	sent.length = 0;
	runningNow = false;
	setSpaceContext(() => ({ thread: { wolf: "w", threadId: "w/a" }, draft: "" }));
	window.addEventListener(DICTATION_AUTOSEND_EVENT, onAutosend);
	const host = dom.document.createElement("div");
	dom.document.body.appendChild(host);
	root = createRoot(host as unknown as Element);
	await act(async () => root!.render(<Hook />));
	mock.timers.enable({ apis: ["setTimeout", "Date"] });
}
afterEach(async () => {
	mock.timers.reset();
	window.removeEventListener(DICTATION_AUTOSEND_EVENT, onAutosend);
	setSpaceContext(null);
	await act(async () => root?.unmount());
	root = null;
});

describe("Space after the window loses focus", () => {
	it("a blur while Space is down disarms it: the pending hold never starts and the next press works", async () => {
		await mountHook();
		key("keydown");
		window.dispatchEvent(new dom.window.Event("blur"));
		mock.timers.tick(400);
		key("keyup");
		assert.deepEqual(calls, [], "no start, no toggle from the abandoned press");
		key("keydown");
		key("keyup");
		assert.deepEqual(calls, ["toggle"], "a fresh tap toggles: nothing is stuck");
	});

	it("a blur during a hold that started the run stops it without sending", async () => {
		await mountHook();
		key("keydown");
		mock.timers.tick(300);
		assert.deepEqual(calls, ["toggle"], "the hold started dictation");
		window.dispatchEvent(new dom.window.Event("blur"));
		key("keyup");
		await act(async () => void (await Promise.resolve()));
		assert.deepEqual(calls, ["toggle", "cancel"], "stopped, not finished");
		assert.deepEqual(sent, [], "nothing is sent");
	});
});

describe("the autosend event", () => {
	it("carries the thread the hold was started for, even if the attachment changes before the release", async () => {
		await mountHook();
		key("keydown");
		mock.timers.tick(300);
		setSpaceContext(() => ({ thread: { wolf: "w", threadId: "w/other" }, draft: "" }));
		key("keyup");
		await act(async () => void (await Promise.resolve()));
		assert.deepEqual(sent, [{ wolf: "w", threadId: "w/a" }]);
	});
});
