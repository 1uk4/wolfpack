import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hideWolf, showWolf, denNeedsYou, partitionWolves, togglePinned, toggleHidden, loadWolfPrefs, saveWolfPrefs, type WolfPrefsStore } from "../../../src/core/thread/wolf-pins.ts";

const g = (wolf: string, id = `${wolf}/home`) => ({ top: { id, meta: wolf } });

describe("wolf pins and hides", () => {
	it("pinned wolves lead in pin order, hidden wolves leave the list, the rest keep their order", () => {
		const groups = [g("a"), g("b"), g("b", "b/f1"), g("c"), g("d")];
		const p = partitionWolves(groups, { pinned: ["c", "b"], hidden: ["d"] });
		assert.deepEqual(p.pinned.map((x) => x.top.id), ["c/home", "b/home", "b/f1"]);
		assert.deepEqual(p.main.map((x) => x.top.id), ["a/home"]);
		assert.deepEqual(p.hidden.map((x) => x.top.id), ["d/home"]);
	});

	it("unpin returns the wolf to the list; hiding a pinned wolf drops its pin; pins keep their order", () => {
		let prefs = togglePinned({ pinned: [], hidden: [] }, "x");
		prefs = togglePinned(prefs, "y");
		assert.deepEqual(prefs.pinned, ["x", "y"]);
		assert.deepEqual(togglePinned(prefs, "x").pinned, ["y"]);
		const h = toggleHidden(prefs, "x");
		assert.deepEqual(h, { pinned: ["y"], hidden: ["x"] });
		assert.deepEqual(toggleHidden(h, "x").hidden, []);
	});

	it("moving to the Den is idempotent and unpins; showing is idempotent; the badge counts needs-you rows of Den wolves only", () => {
		const prefs = hideWolf({ pinned: ["a"], hidden: [] }, "a");
		assert.deepEqual(prefs, { pinned: [], hidden: ["a"] });
		assert.equal(hideWolf(prefs, "a"), prefs);
		assert.deepEqual(showWolf(prefs, "a").hidden, []);
		assert.equal(showWolf({ pinned: [], hidden: [] }, "a").hidden.length, 0);
		const rows = [{ id: "a/home", meta: "a", needsYou: true }, { id: "a/f", meta: "a", needsYou: true }, { id: "a/g", meta: "a" }, { id: "b/home", meta: "b", needsYou: true }];
		assert.equal(denNeedsYou(rows, prefs), 2);
	});

	it("persists in storage and falls back to empty when storage throws or holds junk", () => {
		const m = new Map<string, string>();
		const ok: WolfPrefsStore = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
		saveWolfPrefs(ok, { pinned: ["a"], hidden: ["b"] });
		assert.deepEqual(loadWolfPrefs(ok), { pinned: ["a"], hidden: ["b"] });
		const boom: WolfPrefsStore = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
		assert.deepEqual(loadWolfPrefs(boom), { pinned: [], hidden: [] });
		assert.doesNotThrow(() => saveWolfPrefs(boom, { pinned: [], hidden: [] }));
		m.set("wolfpack:sidebar-wolf-prefs", "{nope");
		assert.deepEqual(loadWolfPrefs(ok), { pinned: [], hidden: [] });
	});
});
