import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { changeSettings, type ThreadSettingsState } from "../components/composer-settings.ts";
import { useThreadColor } from "../components/use-thread-color.ts";
import { autoThreadColor, beginColorChange, knownColor, onThreadColor, pendingColor, resetThreadColorStore, settleColorChange, threadColorIndex, threadColor } from "../src/core/index.ts";

afterEach(() => resetThreadColorStore());

const run = async (start: ThreadSettingsState, patch: Parameters<typeof changeSettings>[0]["patch"], fail: boolean) => {
	let state = start;
	const r = await changeSettings({
		current: start,
		patch,
		put: async () => {
			if (fail) throw new Error("refused");
			return state;
		},
		set: (u) => void (state = u(state)),
	});
	return { state, r };
};

describe("changeSettings color rollback", () => {
	it("a refused null-reset puts the old color back", async () => {
		const { state, r } = await run({ tier: "main", autoShip: false, color: "red" }, { color: null }, true);
		assert.equal(r.ok, false);
		assert.equal(state.color, "red");
	});
	it("a refused color-only change leaves tier and autoShip alone and removes the color it set", async () => {
		const { state } = await run({ tier: "smart", autoShip: true }, { color: "blue" }, true);
		assert.equal(state.color, undefined);
		assert.equal(state.tier, "smart");
		assert.equal(state.autoShip, true);
	});
	it("a refused change does not undo a later color pick", async () => {
		let state: ThreadSettingsState = { tier: "main", autoShip: false, color: "red" };
		let reject!: (e: Error) => void;
		const first = changeSettings({
			current: state,
			patch: { color: "green" },
			put: () => new Promise((_, rj) => (reject = rj)),
			set: (u) => void (state = u(state)),
		});
		state = { ...state, color: "pink" }; // a later pick
		reject(new Error("no"));
		await first;
		assert.equal(state.color, "pink");
	});
});

describe("thread color store", () => {
	it("announces picks and keeps the last known value", () => {
		const seen: Array<[string, string | null]> = [];
		onThreadColor((id, c) => void seen.push([id, c]));
		const seq = beginColorChange("w/a", "teal", null);
		assert.deepEqual(pendingColor("w/a"), { color: "teal" });
		assert.equal(settleColorChange("w/a", seq, true), true);
		assert.equal(pendingColor("w/a"), undefined);
		assert.deepEqual(knownColor("w/a"), { color: "teal" });
		assert.deepEqual(seen, [["w/a", "teal"], ["w/a", "teal"]]);
	});
	it("an older failure after a newer pick does not roll back (out of order)", () => {
		const a = beginColorChange("w/a", "red", null);
		const b = beginColorChange("w/a", "blue", null);
		assert.equal(settleColorChange("w/a", a, false), false); // stale: ignored
		assert.deepEqual(knownColor("w/a"), { color: "blue" });
		assert.equal(settleColorChange("w/a", b, true), true);
		assert.deepEqual(knownColor("w/a"), { color: "blue" });
	});
	it("the latest failing rolls back to the value from before; a first failure to the current value", () => {
		const a = beginColorChange("w/a", "red", "pink");
		settleColorChange("w/a", a, false);
		assert.deepEqual(knownColor("w/a"), { color: "pink" });
		const b = beginColorChange("w/b", null, "green");
		settleColorChange("w/b", b, false);
		assert.deepEqual(knownColor("w/b"), { color: "green" });
	});
});

describe("subagent tint", () => {
	const Probe = ({ id, parent, all }: { id: string; parent?: string; all: { id: string; settings?: { color?: string } }[] }) =>
		createElement("i", { "data-key": useThreadColor({ id, ...(parent ? { parentThreadId: parent } : {}) }, all).key });
	const key = (html: string) => /data-key="(\w+)"/.exec(html)![1];

	it("the live view colors a subagent with its parent's override, else its parent's automatic color", () => {
		const all = [{ id: "w/p", settings: { color: "purple" } }, { id: "w/kid" }];
		assert.equal(key(renderToStaticMarkup(createElement(Probe, { id: "w/kid", parent: "w/p", all }))), "purple");
		assert.equal(key(renderToStaticMarkup(createElement(Probe, { id: "w/kid", parent: "w/q", all }))), autoThreadColor("w/q"));
	});
	it("a pick announced on the store reaches the parent's subagent", () => {
		const all = [{ id: "w/p" }, { id: "w/kid" }];
		const seq = beginColorChange("w/p", "orange", null);
		settleColorChange("w/p", seq, true);
		assert.equal(key(renderToStaticMarkup(createElement(Probe, { id: "w/kid", parent: "w/p", all }))), "orange");
	});
	it("threadColor takes a prebuilt Map index", () => {
		const idx = threadColorIndex([{ id: "w/p", color: "teal" }]);
		assert.equal(threadColor({ id: "w/k", parentThreadId: "w/p" }, idx).key, "teal");
	});
});
