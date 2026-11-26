/** One-time re-centre of an off-origin layout (core/graph/recentre.ts). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recentreCamera, recentreOffset, translatePoints } from "../../../src/core/graph/recentre.ts";

const off = [
	{ x: 4000, y: 3000 },
	{ x: 4600, y: 3000 },
	{ x: 4300, y: 3600 },
	{ x: 4100, y: 3400 },
];

describe("recentre", () => {
	it("centres the layout and keeps relative distances", () => {
		const o = recentreOffset(off)!;
		assert.deepEqual(o, { x: 4250, y: 3250 });
		const moved = translatePoints(off, o);
		assert.deepEqual(moved[0], { x: -250, y: -250 });
		assert.deepEqual(moved[1], { x: 350, y: -250 });
		// dx between node 0 and 1 stays 600, dy between 0 and 2 stays 600
		assert.equal(moved[1]!.x - moved[0]!.x, 600);
		assert.equal(moved[2]!.y - moved[0]!.y, 600);
	});

	it("shifts the camera so a world point keeps its screen point", () => {
		const cam = { k: 0.5, x: -1900, y: -1300 };
		const o = recentreOffset(off)!;
		const next = recentreCamera(cam, o);
		const p = off[2]!;
		const q = translatePoints([p], o)[0]!;
		assert.deepEqual([q.x * next.k + next.x, q.y * next.k + next.y], [p.x * cam.k + cam.x, p.y * cam.k + cam.y]);
		assert.equal(next.k, 0.5);
	});

	it("leaves a layout near the origin alone", () => {
		const near = [{ x: -500, y: -400 }, { x: 600, y: 500 }, { x: 50, y: 40 }, { x: 80, y: 20 }];
		assert.equal(recentreOffset(near), null);
		assert.equal(recentreOffset([]), null);
	});
});
