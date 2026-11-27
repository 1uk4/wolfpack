import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newRepeller, repelStep, type Repeller } from "../../components/graph/live/live-repel.ts";
import { LIVE_TUNING } from "../../components/graph/live/live-tuning.ts";

const T = LIVE_TUNING;
// k = 1: world units are screen px. Contact distance of two 17 px home badges = 17 + 17 + 6 gap = 40.
const body = (x: number, y: number, r: number, mass: number, o: Partial<Repeller> = {}): Repeller => ({ ...newRepeller(), x, y, r, mass, relax: T.repelRelax, ...o });
const dist = (a: Repeller, b: Repeller) => Math.hypot(a.x - b.x, a.y - b.y);
const run = (bs: Repeller[], steps: number, reduced = false) => {
	for (let i = 0; i < steps; i++) repelStep(bs, bs.length, T, 1, 1 / 60, reduced);
};

describe("badge repulsion", () => {
	it("two overlapping badges separate to contact distance within half a second and then stand still", () => {
		const a = body(0, 0, 17, T.massHome);
		const b = body(10, 0, 17, T.massHome);
		run([a, b], 30);
		assert.ok(dist(a, b) >= 40 - 1e-6, `separated (${dist(a, b)})`);
		run([a, b], 150);
		assert.ok(Math.hypot(a.rvx, a.rvy) < 0.5 && Math.hypot(b.rvx, b.rvy) < 0.5, "no jitter at rest");
		const d0 = dist(a, b);
		run([a, b], 30);
		assert.ok(Math.abs(dist(a, b) - d0) < 0.5, "and it stays put");
	});

	it("the lighter badge is pushed further than the heavier one", () => {
		const home = body(0, 0, 17, T.massHome);
		const sub = body(20, 0, 7, T.massSub);
		run([home, sub], 30);
		assert.ok(Math.abs(sub.x - 20) > Math.abs(home.x) * 2, `sub moved ${sub.x - 20}, home ${home.x}`);
	});

	it("two badges parked at one KB node fan out around it and both stay clear of the dot", () => {
		const node = { x: 100, y: 100, r: 8 };
		const clear = node.r + 12 + T.parkGapPx; // a 12 px feature badge beside a node
		const mk = (ang: number) => body(100 + clear, 100, 12, T.massFeature, { nx: node.x, ny: node.y, nr: node.r, ang });
		const a = mk(1);
		const b = mk(2);
		run([a, b], 200);
		assert.ok(Math.hypot(a.x - 100, a.y - 100) >= clear - 1e-6 && Math.hypot(b.x - 100, b.y - 100) >= clear - 1e-6, "clear of the node");
		assert.ok(dist(a, b) >= 12 + 12 + T.repelGapPx - 1e-6, "not stacked");
	});

	it("a sub-agent pushed by a heavy neighbour stays within its tether stretch", () => {
		const max = 22;
		const sub = body(0, 0, 7, T.massSub, { relax: T.repelSubRelax, maxOff: max });
		const home = body(-2, 0, 17, T.massHome);
		for (let i = 0; i < 300; i++) {
			home.x += 0.8; // a wolf walking straight through it
			repelStep([sub, home], 2, T, 1, 1 / 60, false);
			assert.ok(Math.hypot(sub.rx, sub.ry) <= max + 1e-6, `stretch ${Math.hypot(sub.rx, sub.ry)}`);
		}
	});

	it("bodies of one feature group do not repel each other", () => {
		const feature = body(0, 0, 12, T.massFeature, { grp: 3 });
		const sub = body(14, 0, 7, T.massSub, { grp: 3 });
		run([feature, sub], 60);
		assert.equal(feature.rx, 0);
		assert.equal(sub.rx, 0);
	});

	it("reduced motion resolves an overlap in one step, to contact and no further", () => {
		const a = body(0, 0, 17, T.massHome);
		const b = body(10, 0, 17, T.massHome);
		repelStep([a, b], 2, T, 1, 1 / 60, true);
		assert.ok(dist(a, b) >= 40 - 1e-6 && dist(a, b) < 40 + 1e-3, `exactly at contact (${dist(a, b)})`);
		assert.equal(a.rvx, 0);
		assert.equal(b.rvx, 0);
	});
});
