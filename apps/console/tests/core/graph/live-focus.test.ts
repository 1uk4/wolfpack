import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeFocus, isFocusNode, touchFocus } from "../../../src/core/graph/live/focus.ts";

describe("a wolf's focus nodes", () => {
	it("keeps the nodes its home thread touched until the trail time passes", () => {
		let l = touchFocus([], "ent:a", 1000);
		l = touchFocus(l, "work:b", 5000);
		assert.deepEqual(activeFocus(l, 11_000, 15_000), ["ent:a", "work:b"]);
		assert.deepEqual(activeFocus(l, 17_000, 15_000), ["work:b"]);
		assert.deepEqual(activeFocus(l, 25_000, 15_000), []);
	});
	it("a repeat touch refreshes the node instead of adding a second one", () => {
		const l = touchFocus(touchFocus([], "ent:a", 1000), "ent:a", 9000);
		assert.equal(l.length, 1);
		assert.deepEqual(activeFocus(l, 20_000, 15_000), ["ent:a"]);
	});
	it("holds at most 4, dropping the oldest", () => {
		let l: ReturnType<typeof touchFocus> = [];
		for (const [i, id] of ["ent:1", "ent:2", "ent:3", "ent:4", "ent:5"].entries()) l = touchFocus(l, id, i * 10);
		assert.deepEqual(activeFocus(l, 50, 1000), ["ent:2", "ent:3", "ent:4", "ent:5"]);
	});
	it("only KB entries and work items count, not domains or sections", () => {
		assert.deepEqual(["ent:x", "work:y", "dom:z", "sec:w"].map(isFocusNode), [true, true, false, false]);
	});
});
