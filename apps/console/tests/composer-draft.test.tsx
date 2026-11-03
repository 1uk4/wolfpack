import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<html><body></body></html>");
const mem = new Map<string, string>();
const localStorage = {
	getItem: (k: string) => mem.get(k) ?? null,
	setItem: (k: string, v: string) => void mem.set(k, v),
	removeItem: (k: string) => void mem.delete(k),
};
Object.assign(globalThis, { window: Object.assign(dom.window, { localStorage }), document: dom.document, IS_REACT_ACT_ENVIRONMENT: true });

const { useComposerDraft, draftKey, readDraft, writeDraft, DRAFT_DEBOUNCE_MS } = await import("../lib/composer-draft.ts");

let apply: (v: string) => void = () => {};
let shown = "";
function Probe({ wolf, thread }: { wolf: string; thread: string }) {
	const [text, setText] = React.useState("");
	const ref = React.useRef("");
	const schedule = useComposerDraft(wolf, thread, ref, (v) => {
		ref.current = v;
		setText(v);
	});
	apply = (v) => {
		ref.current = v;
		setText(v);
		schedule(v);
	};
	shown = text;
	return null;
}

let root: Root | null = null;
const mount = (wolf = "w", thread = "t1") => {
	root = createRoot(document.createElement("div"));
	act(() => root!.render(<Probe wolf={wolf} thread={thread} />));
};
const unmount = () => {
	act(() => root!.unmount());
	root = null;
};
afterEach(() => {
	if (root) unmount();
	mem.clear();
	mock.timers.reset();
});

describe("composer draft", () => {
	it("writes after the debounce and restores after remount", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		mount();
		act(() => apply("hello"));
		assert.equal(mem.get(draftKey("w", "t1")), undefined);
		mock.timers.tick(DRAFT_DEBOUNCE_MS);
		assert.equal(mem.get("wolfpack:draft:w:t1"), "hello");
		unmount();
		mount();
		assert.equal(shown, "hello");
	});

	it("flushes on unmount before the debounce fires", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		mount();
		act(() => apply("pending"));
		unmount();
		assert.equal(mem.get("wolfpack:draft:w:t1"), "pending");
	});

	it("keeps separate drafts per thread and swaps on thread switch", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		mount("w", "t1");
		act(() => apply("one"));
		act(() => root!.render(<Probe wolf="w" thread="t2" />));
		assert.equal(shown, "");
		act(() => apply("two"));
		mock.timers.tick(DRAFT_DEBOUNCE_MS);
		assert.equal(mem.get("wolfpack:draft:w:t1"), "one");
		assert.equal(mem.get("wolfpack:draft:w:t2"), "two");
		act(() => root!.render(<Probe wolf="w" thread="t1" />));
		assert.equal(shown, "one");
	});

	it("a wolf-only key change flushes the old draft and restores the new wolf's", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		mem.set("wolfpack:draft:w2:t1", "other wolf");
		mount("w", "t1");
		act(() => apply("mine"));
		act(() => root!.render(<Probe wolf="w2" thread="t1" />));
		assert.equal(mem.get("wolfpack:draft:w:t1"), "mine");
		assert.equal(shown, "other wolf");
	});

	it("restoring an empty draft clears stale text", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		mount("w", "t1");
		act(() => apply("stale"));
		act(() => root!.render(<Probe wolf="w" thread="t9" />));
		assert.equal(shown, "");
	});

	it("flushes on pagehide and when the page turns hidden, and removes the listeners", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		mount();
		act(() => apply("bye"));
		window.dispatchEvent(new dom.window.Event("pagehide"));
		assert.equal(mem.get("wolfpack:draft:w:t1"), "bye");
		mem.clear();
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		document.dispatchEvent(new dom.window.Event("visibilitychange"));
		assert.equal(mem.get("wolfpack:draft:w:t1"), "bye");
		unmount();
		mem.clear();
		window.dispatchEvent(new dom.window.Event("pagehide"));
		assert.equal(mem.size, 0, "listeners removed on unmount");
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
	});

	it("readDraft and writeDraft survive a throwing storage", () => {
		const orig = localStorage.getItem;
		localStorage.getItem = () => {
			throw new Error("denied");
		};
		const set = localStorage.setItem;
		localStorage.setItem = () => {
			throw new Error("quota");
		};
		try {
			assert.equal(readDraft("k"), "");
			assert.doesNotThrow(() => writeDraft("k", "x"));
			mount();
			act(() => apply("typing"));
			assert.doesNotThrow(() => unmount());
		} finally {
			localStorage.getItem = orig;
			localStorage.setItem = set;
		}
	});

	it("an emptied composer (send clears it) removes the key", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		mount();
		act(() => apply("x"));
		mock.timers.tick(DRAFT_DEBOUNCE_MS);
		assert.equal(mem.size, 1);
		act(() => apply(""));
		assert.equal(mem.size, 0);
	});
});
