/** Viewer URL state: `?view=<kind>:<id>` mirrors the top of the stack (router.replace only), and wins on load. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).self ??= globalThis;
const ls = new Map<string, string>();
Object.assign(globalThis, {
	window: Object.assign(dom.window, { localStorage: { getItem: (k: string) => ls.get(k) ?? null, setItem: (k: string, v: string) => void ls.set(k, v), removeItem: (k: string) => void ls.delete(k) } }),
	document: dom.document,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { nextSearch, mergeOnLoad, useViewerUrlSync, noteUrlWrite } = await import("../../../components/viewer/viewer-url.ts");
const { useViewer, resetViewerCache } = await import("../../../components/viewer/viewer-store.ts");
const { FakeNav, navLog, currentUrl } = await import("../../helpers/fake-nav.tsx");

const w = { kind: "work", id: "work-wolfpack-a" };
const k = { kind: "kb", id: "kb-wolfpack-b" };

describe("nextSearch", () => {
	it("sets view from the top and keeps other params", () => {
		assert.equal(nextSearch("a=1&b=2", "work:x"), "a=1&b=2&view=work%3Ax");
		assert.equal(nextSearch("a=1&view=kb%3Ay", "work:x"), "a=1&view=work%3Ax");
	});
	it("clears view on close, keeping other params", () => {
		assert.equal(nextSearch("a=1&view=kb%3Ay", null), "a=1");
		assert.equal(nextSearch("view=kb%3Ay", null), "");
	});
});

describe("mergeOnLoad", () => {
	it("pushes the URL view on top of the saved stack and opens", () => {
		assert.deepEqual(mergeOnLoad({ stack: [w], open: false }, "kb:kb-wolfpack-b"), { stack: [w, k], open: true });
	});
	it("does not duplicate when the saved top equals it", () => {
		assert.deepEqual(mergeOnLoad({ stack: [w, k], open: false }, "kb:kb-wolfpack-b"), { stack: [w, k], open: true });
	});
	it("keeps saved state without ?view=, and ignores an invalid one", () => {
		assert.equal(mergeOnLoad({ stack: [w], open: true }, null), null);
		assert.equal(mergeOnLoad({ stack: [w], open: true }, "garbage"), null);
	});
});

let root: Root | null = null;
let ctl: ReturnType<typeof useViewer> | null = null;
function Probe() {
	ctl = useViewer("1uk4", "t1");
	useViewerUrlSync("1uk4", "t1");
	return null;
}
const mount = (start: string) => {
	const el = document.createElement("div");
	document.body.appendChild(el);
	root = createRoot(el);
	act(() => root!.render(<FakeNav start={start}><Probe /></FakeNav>));
};
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	ls.clear();
	resetViewerCache();
});

describe("useViewerUrlSync", () => {
	it("replaces (never pushes) the URL on open and clears it on close", () => {
		mount("/t?x=1");
		act(() => ctl!.openView(w));
		assert.equal(currentUrl(), "/t?x=1&view=work%3Awork-wolfpack-a");
		act(() => ctl!.closeViewer());
		assert.equal(currentUrl(), "/t?x=1");
		assert.equal(navLog.stack.length, 1);
	});
	it("a ?view= on load wins, pushed on the saved stack", () => {
		ls.set("wolfpack:viewer:1uk4:t1", JSON.stringify({ stack: [w], open: false }));
		mount("/t?view=kb%3Akb-wolfpack-b");
		assert.deepEqual(ctl!.stack, [w, k]);
		assert.equal(ctl!.open, true);
	});
	it("a deep link still opens after an earlier noteUrlWrite that nothing consumed", () => {
		noteUrlWrite(""); // e.g. a tab switch whose navigation never reached this page
		mount("/t?view=kb%3Akb-wolfpack-b");
		assert.deepEqual(ctl!.stack, [k]);
		assert.equal(ctl!.open, true);
	});
});
