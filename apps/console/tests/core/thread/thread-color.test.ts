import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { THREAD_COLOR_KEYS, autoThreadColor, threadColor } from "../../../src/core/index.ts";

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
	it("a subagent gets its parent's automatic color, even if the parent is unknown", () => {
		const kid = { id: "w/sub-1", parentThreadId: "w/feature-a" };
		assert.equal(threadColor(kid, [{ id: "w/feature-a" }, kid]).key, autoThreadColor("w/feature-a"));
		assert.equal(threadColor(kid).key, autoThreadColor("w/feature-a"));
	});
	it("the wolf's color colors its home thread and the home thread's subagents, nothing else", () => {
		const home = { id: "w/home", kind: "home" };
		const feature = { id: "w/feature-a", kind: "feature" };
		const sub = { id: "w/sub-1", kind: "subagent", parentThreadId: "w/home" };
		const featureSub = { id: "w/sub-2", kind: "subagent", parentThreadId: "w/feature-a" };
		const all = [home, feature, sub, featureSub];
		assert.deepEqual([threadColor(home, all, "pink").key, threadColor(home, all, "pink").overridden], ["pink", true]);
		assert.equal(threadColor(sub, all, "pink").key, "pink");
		assert.equal(threadColor(feature, all, "pink").key, autoThreadColor("w/feature-a"));
		assert.equal(threadColor(featureSub, all, "pink").key, autoThreadColor("w/feature-a"));
	});
	it("an unset or invalid wolf color falls back to the automatic color", () => {
		const home = { id: "w/home", kind: "home" };
		for (const c of [undefined, null, "nope"]) assert.equal(threadColor(home, [home], c).key, autoThreadColor("w/home"));
	});
});
