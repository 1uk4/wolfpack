import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flightPos } from "../../components/graph/live/kb-life-draw.ts";
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
