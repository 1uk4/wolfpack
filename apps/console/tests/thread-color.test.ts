import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { THREAD_COLOR_KEYS, autoThreadColor, threadColor } from "../src/core/index.ts";

describe("threadColor", () => {
	it("gives the same id the same color, one of the 8", () => {
		for (const id of ["w/home", "w/feature-work-x-1", "w/sub-1", "", "ünï"]) {
			const a = threadColor({ id });
			assert.deepEqual(threadColor({ id }), a);
			assert.ok((THREAD_COLOR_KEYS as readonly string[]).includes(a.key));
			assert.equal(a.overridden, false);
			assert.match(a.hex, /^#[0-9a-f]{6}$/);
		}
	});
	it("spreads ids over the palette", () => {
		const keys = new Set(Array.from({ length: 200 }, (_, i) => autoThreadColor(`w/feature-${i}`)));
		assert.equal(keys.size, 8);
	});
	it("a subagent gets its parent's color (override first, else automatic, even if the parent is unknown)", () => {
		const parent = { id: "w/feature-a", settings: { color: "pink" } };
		const kid = { id: "w/sub-1", parentThreadId: "w/feature-a" };
		const c = threadColor(kid, [parent, kid]);
		assert.equal(c.key, "pink");
		assert.equal(c.overridden, true);
		assert.equal(threadColor(kid, [{ id: "w/feature-a" }, kid]).key, autoThreadColor("w/feature-a"));
		assert.equal(threadColor(kid).key, autoThreadColor("w/feature-a"));
	});
	it("an override wins, a row-level color works, an invalid one falls back to automatic", () => {
		assert.equal(threadColor({ id: "w/home", settings: { color: "teal" } }).key, "teal");
		assert.equal(threadColor({ id: "w/home", color: "red" }).key, "red");
		assert.equal(threadColor({ id: "w/home", color: "nope" }).key, autoThreadColor("w/home"));
	});
});

import { changeSettings, type ThreadSettingsState } from "../components/composer-settings.ts";

describe("color override through changeSettings", () => {
	it("sets, resets to automatic, and rolls back a refused change", async () => {
		let state: ThreadSettingsState = { tier: "main", autoShip: false };
		const set = (u: (s: ThreadSettingsState) => ThreadSettingsState) => void (state = u(state));
		await changeSettings({ current: state, patch: { color: "blue" }, put: async () => state, set });
		assert.equal(state.color, "blue");
		await changeSettings({ current: state, patch: { color: null }, put: async () => state, set });
		assert.equal(state.color, undefined);
		await changeSettings({ current: { ...state, color: "red" }, patch: { color: "green" }, put: async () => { throw new Error("no"); }, set: (u) => void (state = u({ ...state, color: "red" })) });
		assert.equal(state.color, "red");
	});
});
