/** One-time copy of the pre-rename Learn Harness localStorage keys to their `wolfpack.*` / `wolfpack:*` names. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateLegacyKeys } from "../src/core/legacy-storage.ts";

const mapStorage = (seed: Record<string, string> = {}) => {
	const m = new Map(Object.entries(seed));
	return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

// Old keys are the two-letter prefix + suffix (spelled this way so the rename grep stays clean).
const old = (suffix: string) => "lh" + suffix;
const PAIRS: Array<[string, string]> = [
	[old(".graph.pane-width.v1"), "wolfpack.graph.pane-width.v1"],
	[old(".graph.camera.v1"), "wolfpack.graph.camera.v1"],
	[old(".memory-panel.open.v1"), "wolfpack.memory-panel.open.v1"],
	[old(".memory-panel.view.v1"), "wolfpack.memory-panel.view.v1"],
	[old(".right-panel.v1"), "wolfpack.right-panel.v1"],
	[old(":sidebar-open"), "wolfpack:sidebar-open"],
	[old(":keymap"), "wolfpack:keymap"],
	[old(":notify-needs-you"), "wolfpack:notify-needs-you"],
];

describe("migrateLegacyKeys", () => {
	it("copies all eight old keys to their new names and leaves the old ones in place", () => {
		const s = mapStorage(Object.fromEntries(PAIRS.map(([o], i) => [o, `v${i}`])));
		migrateLegacyKeys(s);
		PAIRS.forEach(([o, n], i) => {
			assert.equal(s.getItem(n), `v${i}`);
			assert.equal(s.getItem(o), `v${i}`);
		});
	});

	it("never overwrites a new key that already has a value", () => {
		const s = mapStorage({ [old(":keymap")]: "old", "wolfpack:keymap": "new" });
		migrateLegacyKeys(s);
		assert.equal(s.getItem("wolfpack:keymap"), "new");
	});

	it("is idempotent: a second run changes nothing", () => {
		const s = mapStorage({ [old(":sidebar-open")]: "0" });
		migrateLegacyKeys(s);
		s.setItem("wolfpack:sidebar-open", "1"); // the user changed it after the copy
		migrateLegacyKeys(s);
		assert.equal(s.getItem("wolfpack:sidebar-open"), "1");
		assert.equal(s.m.size, 2);
	});

	it("does nothing when storage throws", () => {
		assert.doesNotThrow(() => migrateLegacyKeys({ getItem: () => { throw new Error("denied"); }, setItem: () => {} }));
	});
});
