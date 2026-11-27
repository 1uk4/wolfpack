import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIVE_TUNING } from "../../components/graph/live/live-tuning.ts";
import { newMotion, restSlot, orbitTarget, tetherStrength, wolfEvent, wolfStep, type WolfCtx } from "../../components/graph/live/live-den.ts";

/** The wolf state machine from the polish concept (p-den): resting, working, lingering, returning. Timers in ms of wall time. */
const DEN = { x: 0, y: 0 };
const ctx = (over: Partial<WolfCtx> = {}): WolfCtx => ({ den: DEN, rest: { x: 84, y: 0 }, needsYou: false, working: true, reduced: false, tuning: LIVE_TUNING, ...over });
/** Step in 100 ms slices from `from` for `sec` seconds; returns the end time. */
function run(m: ReturnType<typeof newMotion>, from: number, sec: number, c: WolfCtx): number {
	let t = from;
	for (let i = 0; i < sec * 10; i++) {
		t += 100;
		wolfStep(m, t, 0.1, c);
	}
	return t;
}

describe("wolf den state machine", () => {
	it("an event sends a resting wolf along its waypoints to the target, where it lingers", () => {
		const m = newMotion(62, 0);
		assert.equal(m.phase, "resting");
		wolfEvent(m, 1000, [{ x: 100, y: 0 }, { x: 300, y: 200 }]);
		assert.equal(m.phase, "working");
		let t = run(m, 1000, 10, ctx());
		assert.equal(m.phase, "working", "a trip takes the pace (30 s), not 10");
		assert.ok(m.x > 62 && m.x < 300, `on its way (${m.x})`);
		t = run(m, t, 25, ctx());
		assert.equal(m.phase, "lingering");
		assert.deepEqual([Math.round(m.x), Math.round(m.y)], [300, 200]);
	});

	it("a wolf returns 180 s after its last event, or 45 s after its thread went idle", () => {
		const a = newMotion(0, 0);
		wolfEvent(a, 0, [{ x: 100, y: 0 }]);
		let t = run(a, 0, 40, ctx({ working: true }));
		assert.equal(a.phase, "lingering");
		t = run(a, t, 130, ctx({ working: true })); // 170 s since the event
		assert.equal(a.phase, "lingering");
		run(a, t, 15, ctx({ working: true })); // 185 s
		assert.equal(a.phase, "returning");

		const b = newMotion(0, 0);
		wolfEvent(b, 0, [{ x: 100, y: 0 }]);
		t = run(b, 0, 40, ctx({ working: false })); // idle since the first step
		assert.equal(b.phase, "lingering", "idle only 39 s");
		run(b, t, 10, ctx({ working: false }));
		assert.equal(b.phase, "returning", "45 s after the turn ended");
	});

	it("a wolf with a needs-you question never returns until answered", () => {
		const m = newMotion(0, 0);
		wolfEvent(m, 0, [{ x: 100, y: 0 }]);
		const t = run(m, 0, 400, ctx({ needsYou: true, working: false }));
		assert.equal(m.phase, "lingering");
		run(m, t, 1, ctx({ needsYou: false, working: false }));
		assert.equal(m.phase, "returning");
	});

	it("a new event while lingering restarts the 180 s clock and travels on from where it is", () => {
		const m = newMotion(0, 0);
		wolfEvent(m, 0, [{ x: 100, y: 0 }]);
		let t = run(m, 0, 170, ctx());
		wolfEvent(m, t, [{ x: 100, y: 100 }]);
		assert.equal(m.phase, "working");
		t = run(m, t, 100, ctx());
		assert.equal(m.phase, "lingering", "100 s after the new event is within its 180 s");
	});

	it("a returning wolf ends back on its resting slot at the den and then rests", () => {
		const m = newMotion(0, 0);
		wolfEvent(m, 0, [{ x: 100, y: 0 }]);
		const t = run(m, 0, 200, ctx());
		assert.equal(m.phase, "returning");
		const t2 = run(m, t, 40, ctx());
		assert.equal(m.phase, "resting");
		run(m, t2, 30, ctx());
		assert.ok(Math.hypot(m.x - 84, m.y) < 1, `settled on its slot (${m.x},${m.y})`);
	});

	it("the den tether strengthens over the linger and is zero otherwise; reduced motion arrives at once", () => {
		const m = newMotion(0, 0);
		assert.equal(tetherStrength(m, 0, LIVE_TUNING), 0);
		wolfEvent(m, 0, [{ x: 100, y: 0 }]);
		run(m, 0, 40, ctx());
		const arrived = m.arrivedAt!;
		assert.equal(tetherStrength(m, arrived, LIVE_TUNING), 0);
		assert.equal(tetherStrength(m, arrived + 22_500, LIVE_TUNING), 0.5);
		assert.equal(tetherStrength(m, arrived + 90_000, LIVE_TUNING), 1);
		const r = newMotion(0, 0);
		wolfEvent(r, 0, [{ x: 100, y: 0 }]);
		wolfStep(r, 100, 0.1, ctx({ reduced: true }));
		assert.equal(r.phase, "lingering");
	});

	it("wolves at rest spread evenly around the den, offline ones a little further out", () => {
		const a = restSlot(0, 3, 0, true, { x: 0, y: 0 }, 1, LIVE_TUNING);
		const b = restSlot(1, 3, 0, true, { x: 0, y: 0 }, 1, LIVE_TUNING);
		const c = restSlot(2, 3, 0, false, { x: 0, y: 0 }, 1, LIVE_TUNING);
		const d = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);
		assert.ok(Math.abs(Math.hypot(a.x, a.y) - 84) < 1e-6);
		assert.ok(d(a, b) > 80, `no overlap (${d(a, b)})`);
		assert.ok(Math.hypot(c.x, c.y) > Math.hypot(a.x, a.y), "offline further out");
	});
});

describe("the force model of a wolf round Home", () => {
	const rest = { x: 84, y: 0 };
	const W = { homeSpring: 1, threadPull: 1, focusPull: 1, subPull: 1 };
	it("with no pulls the wolf sits on its rest slot, on the 84 px orbit", () => {
		assert.deepEqual(orbitTarget(rest, [], [], [], W, false), { x: 84, y: 0 });
	});
	it("a thread pull moves it toward the thread but less far than the thread, bounded by the spring", () => {
		const p = orbitTarget(rest, [{ x: 84, y: 200 }], [], [], W, false);
		assert.equal(p.x, 84);
		assert.equal(p.y, 100);
	});
	it("more subPull moves it further and a larger homeSpring pulls it back", () => {
		const sub = [{ x: 84, y: 100 }];
		assert.equal(orbitTarget(rest, [], [], sub, W, false).y, 50);
		assert.equal(orbitTarget(rest, [], [], sub, { ...W, subPull: 3 }, false).y, 75);
		assert.equal(orbitTarget(rest, [], [], sub, { ...W, homeSpring: 3 }, false).y, 25);
	});
	it("a focus pull draws it toward the node it reads", () => {
		assert.equal(orbitTarget(rest, [], [{ x: 84, y: 60 }], [], { ...W, focusPull: 2 }, false).y, 40);
	});
	it("reduced motion gives the target at once, with no travel", () => {
		const m = newMotion(0, 0);
		wolfStep(m, 0, 0.1, ctx({ working: false, reduced: true, rest: { x: 84, y: 100 } }));
		assert.deepEqual([m.x, m.y], [84, 100]);
	});
});
