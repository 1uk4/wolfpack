import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PHYSICS, springStrength, stepWolves, type WolfBody } from "../../../src/core/graph/live/live-physics.ts";

const body = (o: Partial<WolfBody> = {}): WolfBody => ({ x: 0, y: 0, vx: 0, vy: 0, ...o });

describe("wolf physics step", () => {
	it("pulls toward the tug target, and the pull decays to almost nothing after a few seconds", () => {
		const b = body({ tug: { x: 100, y: 0, at: 0 } });
		stepWolves([b], 0, 0.016);
		assert.ok(b.vx > 0);
		assert.ok(springStrength(DEFAULT_PHYSICS, 10_000) < DEFAULT_PHYSICS.spring * 0.02);
		const late = body({ tug: { x: 100, y: 0, at: 0 } });
		stepWolves([late], 20_000, 0.016);
		assert.ok(Math.abs(late.vx) < 0.1);
	});

	it("never exceeds the speed clamp", () => {
		const b = body({ vx: 5000, vy: 5000 });
		stepWolves([b], 0, 0.05);
		assert.ok(Math.hypot(b.vx, b.vy) <= DEFAULT_PHYSICS.maxSpeed + 1e-9);
	});

	it("pushes two close wolves apart", () => {
		const a = body({ x: -5 });
		const c = body({ x: 5 });
		stepWolves([a, c], 0, 0.016);
		assert.ok(a.vx < 0 && c.vx > 0);
	});

	it("pulls weakly toward the home centroid when nothing else acts", () => {
		const b = body({ x: 0, home: { x: 200, y: 0 } });
		stepWolves([b], 0, 0.016);
		assert.ok(b.vx > 0 && b.vx < 5);
	});
});
