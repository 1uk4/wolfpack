import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const mem = new Map<string, string>();
const localStorage = {
	getItem: (k: string) => mem.get(k) ?? null,
	setItem: (k: string, v: string) => void mem.set(k, v),
	removeItem: (k: string) => void mem.delete(k),
};
Object.assign(globalThis, { window: { localStorage } });

const { openView, pushView, backView, closeViewer, clearViewer, getViewerState, flushViewer, resetViewerCache, viewerKey } = await import("../../../components/viewer/viewer-store.ts");

const W = "hal";
const T = "t1";
const a = { kind: "work", id: "A" };
const b = { kind: "work", id: "B" };
const ids = (t = T) => getViewerState(W, t).stack.map((d) => d.id);

beforeEach(() => {
	mem.clear();
	resetViewerCache();
});

describe("viewer store", () => {
	it("opens a view and does not duplicate the top", () => {
		openView(W, T, a);
		openView(W, T, { ...a });
		assert.deepEqual(ids(), ["A"]);
		assert.equal(getViewerState(W, T).open, true);
	});

	it("pushes onto the stack and back returns to the previous view", () => {
		openView(W, T, a);
		pushView(W, T, b);
		pushView(W, T, b);
		assert.deepEqual(ids(), ["A", "B"]);
		backView(W, T);
		assert.deepEqual(ids(), ["A"]);
		assert.equal(getViewerState(W, T).open, true);
	});

	it("back from the last view empties the stack and closes", () => {
		openView(W, T, a);
		backView(W, T);
		assert.deepEqual(getViewerState(W, T), { stack: [], open: false });
	});

	it("close hides the panel but keeps the stack; clear drops it", () => {
		openView(W, T, a);
		pushView(W, T, b);
		closeViewer(W, T);
		assert.deepEqual(getViewerState(W, T), { stack: [a, b], open: false });
		clearViewer(W, T);
		assert.deepEqual(getViewerState(W, T), { stack: [], open: false });
	});

	it("keeps at most 50 views", () => {
		for (let i = 0; i < 60; i++) pushView(W, T, { kind: "work", id: `n${i}` });
		assert.equal(getViewerState(W, T).stack.length, 50);
		assert.equal(ids()[49], "n59");
	});

	it("survives a reload through localStorage", () => {
		openView(W, T, a);
		pushView(W, T, b);
		flushViewer();
		assert.deepEqual(JSON.parse(mem.get("wolfpack:viewer:hal:t1")!), { stack: [a, b], open: true });
		resetViewerCache();
		assert.deepEqual(getViewerState(W, T), { stack: [a, b], open: true });
	});

	it("localStorage throwing → memory fallback", () => {
		const real = (globalThis as { window: { localStorage: unknown } }).window.localStorage;
		const boom = () => {
			throw new Error("denied");
		};
		(globalThis as { window: { localStorage: unknown } }).window.localStorage = { getItem: boom, setItem: boom, removeItem: boom };
		try {
			assert.deepEqual(getViewerState(W, T), { stack: [], open: false });
			openView(W, T, a);
			pushView(W, T, b);
			flushViewer();
			assert.deepEqual(ids(), ["A", "B"]);
			assert.equal(getViewerState(W, T).open, true);
		} finally {
			(globalThis as { window: { localStorage: unknown } }).window.localStorage = real;
		}
	});

	it("keeps threads separate", () => {
		openView(W, "t1", a);
		assert.deepEqual(getViewerState(W, "t2"), { stack: [], open: false });
		assert.notEqual(viewerKey(W, "t1"), viewerKey(W, "t2"));
	});
});
