/** Pinned views in pin-store: many per thread, persisted, independent of the object dismissals. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
	window: { addEventListener() {}, removeEventListener() {} },
	localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const ps = await import("../../../components/thread/pin-store.ts");

beforeEach(() => {
	store.clear();
	ps.resetDismissedCache();
	ps.resetPinnedViewsCache();
});

describe("pinned views", () => {
	it("pins many views per thread, unpins one by kind+id, and keeps threads apart", () => {
		ps.pinView("t1", { kind: "work", id: "w1", title: "One" });
		ps.pinView("t1", { kind: "kb", id: "k1", title: "Entry" });
		ps.pinView("t1", { kind: "work", id: "w1", title: "One again" }); // re-pin: no duplicate
		assert.deepEqual(ps.getPinnedViews("t1").map((d) => `${d.kind}:${d.id}`), ["work:w1", "kb:k1"]);
		assert.equal(ps.isViewPinned("t1", { kind: "kb", id: "k1" }), true);
		assert.equal(ps.isViewPinned("t2", { kind: "kb", id: "k1" }), false);
		ps.unpinView("t1", { kind: "work", id: "w1" });
		assert.deepEqual(ps.getPinnedViews("t1"), [{ kind: "kb", id: "k1", title: "Entry" }]);
	});

	it("survives a reload and does not touch object dismissals", () => {
		ps.dismiss(ps.dismissKey("t1", "obj"));
		ps.pinView("t1", { kind: "work", id: "w1", title: "One" });
		ps.resetPinnedViewsCache(); // forget memory, storage stays
		assert.deepEqual(ps.getPinnedViews("t1"), [{ kind: "work", id: "w1", title: "One" }]);
		ps.unpinView("t1", { kind: "work", id: "w1" });
		assert.deepEqual(ps.getPinnedViews("t1"), []);
		assert.equal(JSON.parse(store.get("wp.pinned-checklist.dismissed.v1")!).length, 1);
	});
});
