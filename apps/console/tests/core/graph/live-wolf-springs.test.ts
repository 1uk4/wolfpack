import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { wolfSpringAnchor } from "../../../src/core/graph/live/live-wolf-springs.ts";

const out = { x: 0, y: 0 };
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} is not ${b}`);

describe("wolf-to-hub springs", () => {
	it("three hubs pull the wolf three quarters of the way from its slot to their centre", () => {
		// ring slot (0,0); three hubs summing to (600, 300): centre (200,100); pull 3/(1+3) = 0.75
		const p = wolfSpringAnchor(0, 0, 600, 300, 3, out);
		close(p.x, 150);
		close(p.y, 75);
		assert.equal(p, out, "writes into the passed object, no allocation");
	});

	it("equal pull from opposite hubs settles the wolf between them, on the line from its slot's side", () => {
		// hubs at (-300, 0) and (300, 0), slot at (0, 40): the pulls cancel sideways; pull 2/3 toward y = 0
		const p = wolfSpringAnchor(0, 40, 0, 0, 2, out);
		close(p.x, 0);
		close(p.y, 40 / 3);
	});

	it("one hub pulls 50%, and the pull is capped at 80% however many hubs there are", () => {
		close(wolfSpringAnchor(0, 0, 100, 0, 1, { x: 0, y: 0 }).x, 50);
		close(wolfSpringAnchor(0, 0, 400, 0, 4, { x: 0, y: 0 }).x, 80); // 4/5
		close(wolfSpringAnchor(0, 0, 1000, 0, 10, { x: 0, y: 0 }).x, 80); // 10/11 would be 91%, capped
	});

	it("no hubs, or a non-finite hub sum, leaves the anchor on its slot", () => {
		const p = wolfSpringAnchor(123, -45, 0, 0, 0, out);
		assert.deepEqual([p.x, p.y], [123, -45]);
		const q = wolfSpringAnchor(7, 9, Number.NaN, Infinity, 2, { x: 0, y: 0 });
		assert.deepEqual([q.x, q.y], [7, 9]);
	});
});
