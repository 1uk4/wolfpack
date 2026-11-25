/** show_view: the "view" object card, its collapse by objectId, and the open-on-arrival rule. */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(globalThis as Record<string, unknown>).self ??= globalThis;
const store = new Map<string, string>();
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	Event: dom.window.Event,
	IS_REACT_ACT_ENVIRONMENT: true,
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const { shouldOpenOnArrival, viewArrivals, ViewHostContext } = await import("../../../components/viewer/use-view-objects.ts");
const { lookupCard } = await import("../../../components/thread/card-registry.tsx");
const { collapseObjects } = await import("../../../src/core/index.ts");
const vs = await import("../../../components/viewer/viewer-store.ts");
const ps = await import("../../../components/thread/pin-store.ts");

let root: Root | null = null;
beforeEach(() => {
	store.clear();
	ps.resetPinnedViewsCache();
	vs.resetViewerCache();
});
afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

const viewPart = (rev: number, id: string, extra: Record<string, unknown> = {}) => ({
	type: "object",
	objectId: "v1",
	objectType: "view",
	rev,
	data: { kind: "work", id, title: `T-${id}` },
	...extra,
});

describe("view objects", () => {
	it("collapse keeps one view per objectId and the latest rev's target", () => {
		const ms = [{ role: "assistant", parts: [viewPart(1, "a"), viewPart(2, "b")] }] as never[];
		collapseObjects(ms);
		const parts = (ms[0] as unknown as { parts: Array<{ rev: number; data: { id: string } }> }).parts;
		assert.equal(parts.length, 1);
		assert.equal(parts[0]!.rev, 2);
		assert.equal(parts[0]!.data.id, "b");
	});

	it("the card says Opened <title> and opens the viewer on click", async () => {
		const Card = lookupCard("object", "view")!.Renderer;
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(
				<ViewHostContext.Provider value={{ wolf: "w", threadId: "t" }}>
					<Card objectId="v1" type="view" rev={1} data={{ kind: "kb", id: "kb-x-1", title: "Sweeps" }} />
				</ViewHostContext.Provider>,
			));
		assert.match(host.textContent ?? "", /Opened Sweeps/);
		await act(async () => void (host.querySelector("button") as HTMLElement).dispatchEvent(new dom.window.Event("click", { bubbles: true })));
		const s = vs.getViewerState("w", "t");
		assert.equal(s.open, true);
		assert.deepEqual(s.stack, [{ kind: "kb", id: "kb-x-1", title: "Sweeps" }]);
	});
});

describe("open on arrival", () => {
	it("opens only for a new view on the visible thread on a wide screen", () => {
		assert.equal(shouldOpenOnArrival({ isNew: true, onScreen: true, viewportWide: true }), true);
		assert.equal(shouldOpenOnArrival({ isNew: true, onScreen: true, viewportWide: false }), false);
		assert.equal(shouldOpenOnArrival({ isNew: true, onScreen: false, viewportWide: true }), false);
		assert.equal(shouldOpenOnArrival({ isNew: false, onScreen: true, viewportWide: true }), false);
	});

	it("reports a view once per rev, not when replayed while idle, and carries pinned", () => {
		const seen = new Set<string>();
		const msgs = (rev: number, id: string, extra = {}) => [{ role: "assistant", parts: [viewPart(rev, id, extra)] }] as never[];
		// history replay (not streaming): marked seen, nothing reported
		assert.deepEqual(viewArrivals(msgs(1, "a"), seen, false, "w"), []);
		// same rev again while streaming: still seen
		assert.deepEqual(viewArrivals(msgs(1, "a"), seen, true, "w"), []);
		// a revision streams in: reported, pinned carried
		assert.deepEqual(viewArrivals(msgs(2, "b", { pinned: true }), seen, true, "w"), [{ descriptor: { kind: "work", id: "b", title: "T-b" }, pinned: true }]);
		assert.deepEqual(viewArrivals(msgs(2, "b", { pinned: true }), seen, true, "w"), []);
	});
});
