/** Unified per-thread pin store (wp.pins.v2): pins, newest-of-type, one expanded, dismissal vs auto-pins, migration, storage fallback. */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const store = new Map<string, string>();
let broken = false;
const boom = () => {
	throw new Error("storage unavailable");
};
Object.assign(globalThis, {
	window: { addEventListener() {}, removeEventListener() {} },
	localStorage: {
		getItem: (k: string) => (broken ? boom() : (store.get(k) ?? null)),
		setItem: (k: string, v: string) => (broken ? boom() : void store.set(k, v)),
		removeItem: (k: string) => (broken ? boom() : void store.delete(k)),
	},
});

const ps = await import("../../../components/thread/pin-store.ts");

const ref = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;
const ids = (t: string) => ps.listPins(t).map(ref);

beforeEach(() => {
	broken = false;
	store.clear();
	ps.resetPinnedViewsCache();
});

describe("unified pin store", () => {
	it("pins, lists and unpins per thread", () => {
		ps.pin("t1", { kind: "work", id: "w1", title: "One", pinnedBy: "owner" });
		ps.pin("t2", { kind: "kb", id: "k1", pinnedBy: "agent" });
		assert.deepEqual(ids("t1"), ["work:w1"]);
		assert.deepEqual(ids("t2"), ["kb:k1"]);
		ps.unpin("t1", { kind: "work", id: "w1" });
		assert.deepEqual(ids("t1"), []);
		assert.deepEqual(ids("t2"), ["kb:k1"]);
	});

	it("keeps only the newest checklist, decision and graph, but many work and kb pins", () => {
		for (const kind of ["checklist", "decision", "graph"] as const) {
			ps.pin("t", { kind, id: "a", pinnedBy: "agent" });
			ps.pin("t", { kind, id: "b", pinnedBy: "agent" });
		}
		ps.pin("t", { kind: "work", id: "w1", pinnedBy: "owner" });
		ps.pin("t", { kind: "work", id: "w2", pinnedBy: "owner" });
		ps.pin("t", { kind: "kb", id: "k1", pinnedBy: "owner" });
		assert.deepEqual(ids("t").sort(), ["checklist:b", "decision:b", "graph:b", "kb:k1", "work:w1", "work:w2"]);
	});

	it("holds a single task pin whatever id is given", () => {
		ps.pin("t", { kind: "task", id: "x", pinnedBy: "agent" });
		ps.pin("t", { kind: "task", id: "y", pinnedBy: "agent" });
		assert.deepEqual(ids("t"), ["task:task"]);
	});

	it("expands one pin at a time; unpinning the expanded one clears it", () => {
		ps.pin("t", { kind: "work", id: "w1", pinnedBy: "owner" });
		ps.pin("t", { kind: "kb", id: "k1", pinnedBy: "owner" });
		ps.setExpanded("t", { kind: "work", id: "w1" });
		assert.equal(ps.getExpanded("t"), "work:w1");
		ps.setExpanded("t", { kind: "kb", id: "k1" });
		assert.equal(ps.getExpanded("t"), "kb:k1");
		ps.unpin("t", { kind: "kb", id: "k1" });
		assert.equal(ps.getExpanded("t"), null);
	});

	it("re-adds a dismissed pin on any later explicit pin", () => {
		ps.pin("t", { kind: "decision", id: "d", pinnedBy: "agent", rev: 1 });
		ps.unpin("t", { kind: "decision", id: "d" });
		ps.pin("t", { kind: "decision", id: "d", pinnedBy: "owner", rev: 1 });
		assert.deepEqual(ids("t"), ["decision:d"]);
	});

	it("auto-pin from the transcript does not resurrect a dismissed object at the same rev, but does at a newer one", () => {
		const obj = (rev: number, extra = {}) => ({ type: "checklist" as const, id: "c", rev, ...extra });
		ps.syncObjectPins("t", [obj(1)]);
		assert.deepEqual(ids("t"), ["checklist:c"]);
		ps.unpin("t", { kind: "checklist", id: "c" });
		ps.syncObjectPins("t", [obj(1)]);
		assert.deepEqual(ids("t"), []);
		ps.syncObjectPins("t", [obj(2)]);
		assert.deepEqual(ids("t"), ["checklist:c"]);
	});

	it("syncObjectPins: explicit pinned:true re-adds a dismissed object, pinned:false removes it", () => {
		ps.syncObjectPins("t", [{ type: "graph", id: "g", rev: 1 }]);
		ps.unpin("t", { kind: "graph", id: "g" });
		ps.syncObjectPins("t", [{ type: "graph", id: "g", rev: 1, pinRev: 1, pinned: true }]);
		assert.deepEqual(ids("t"), ["graph:g"]);
		ps.syncObjectPins("t", [{ type: "graph", id: "g", rev: 2, pinRev: 2, pinned: false }]);
		assert.deepEqual(ids("t"), []);
	});

	it("persists across a reload under wp.pins.v2", () => {
		ps.pin("t", { kind: "work", id: "w1", title: "One", pinnedBy: "owner" });
		ps.setExpanded("t", { kind: "work", id: "w1" });
		ps.resetPinnedViewsCache();
		assert.deepEqual(ps.listPins("t"), [{ kind: "work", id: "w1", title: "One", pinnedBy: "owner" }]);
		assert.equal(ps.getExpanded("t"), "work:w1");
		assert.ok(store.has("wp.pins.v2"));
	});

	it("migrates the old pinned views and dismissed list once, leaving the old keys", () => {
		store.set("wp.pinned-views.v1", JSON.stringify({ t: [{ kind: "work", id: "w1", title: "One" }, { kind: "kb", id: "k1" }] }));
		store.set("wp.pinned-checklist.dismissed.v1", JSON.stringify([JSON.stringify(["t", "c"]), JSON.stringify(["t", "decision:d", 2]), "garbage"]));
		assert.deepEqual(ps.listPins("t"), [
			{ kind: "work", id: "w1", title: "One", pinnedBy: "owner" },
			{ kind: "kb", id: "k1", pinnedBy: "owner" },
		]);
		ps.syncObjectPins("t", [{ type: "checklist", id: "c", rev: 5 }, { type: "decision", id: "d", rev: 5 }]);
		assert.deepEqual(ids("t").sort(), ["kb:k1", "work:w1"]); // both dismissed objects stay dismissed
		ps.unpin("t", { kind: "work", id: "w1" });
		ps.resetPinnedViewsCache();
		assert.deepEqual(ids("t"), ["kb:k1"]); // not re-migrated
		assert.ok(store.has("wp.pinned-views.v1") && store.has("wp.pinned-checklist.dismissed.v1"));
	});

	it("falls back to memory when storage throws", () => {
		broken = true;
		ps.pin("t", { kind: "work", id: "w1", pinnedBy: "owner" });
		ps.setExpanded("t", { kind: "work", id: "w1" });
		assert.deepEqual(ids("t"), ["work:w1"]);
		assert.equal(ps.getExpanded("t"), "work:w1");
	});

	it("keeps the old view wrappers on the same store", () => {
		ps.pinView("t", { kind: "work", id: "w1", title: "One" });
		assert.deepEqual(ids("t"), ["work:w1"]);
		ps.pin("t", { kind: "kb", id: "k1", title: "E", pinnedBy: "agent" });
		assert.deepEqual(ps.getPinnedViews("t"), [{ kind: "work", id: "w1", title: "One" }, { kind: "kb", id: "k1", title: "E" }]);
	});
});
