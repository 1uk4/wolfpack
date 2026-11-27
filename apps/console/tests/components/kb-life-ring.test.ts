import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flightPos, ITEM_TRAVEL_MS, itemPos } from "../../components/graph/live/kb-life-draw.ts";
import { LIVE_TUNING } from "../../components/graph/live/live-tuning.ts";

describe("memory items orbit Home on the inner ring", () => {
	it("a flight's slot lies between the Home disc and the wolves' rest orbit", () => {
		const home = { x: 100, y: 50 };
		const f = { id: "f", wolf: "hal", stage: "hold", slot: 2, at: 0, endAt: 1 } as never;
		const p = flightPos(f, home, home, null, 0, 1, true, 1);
		const r = Math.hypot(p.x - home.x, p.y - home.y);
		assert.ok(Math.abs(r - 40) < 1e-6, `radius ${r}`);
		assert.ok(r > LIVE_TUNING.denRadiusPx && r < LIVE_TUNING.restRadiusPx);
	});
});

describe("a memory item travels from its wolf to the ring", () => {
	const home = { x: 0, y: 0 };
	const wolf = { x: 200, y: 0 };
	const dist = (p: { x: number; y: number }) => Math.hypot(p.x - home.x, p.y - home.y);
	it("is born at its wolf, then lands on the ring round Home and stays there", () => {
		const born = 1000;
		assert.deepEqual(itemPos(wolf, home, 3, born, born, 1, false), wolf);
		const mid = dist(itemPos(wolf, home, 3, born, born + ITEM_TRAVEL_MS / 2, 1, false));
		assert.ok(mid > 40 && mid < 200, `mid-flight ${mid}`);
		assert.ok(Math.abs(dist(itemPos(wolf, home, 3, born, born + ITEM_TRAVEL_MS, 1, false)) - 40) < 1e-6);
		assert.ok(Math.abs(dist(itemPos(wolf, home, 3, born, born + 60_000, 1, false)) - 40) < 1e-6);
	});
	it("under reduced motion appears on the ring with no travel", () => {
		assert.ok(Math.abs(dist(itemPos(wolf, home, 3, 1000, 1000, 1, true)) - 40) < 1e-6);
	});
});
