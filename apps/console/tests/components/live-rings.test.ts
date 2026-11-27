import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIVE_TUNING } from "../../components/graph/live/live-tuning.ts";
import { elasticStep, orbitPhase, pullFor, ringSlots, trailOrigin } from "../../components/graph/live/live-rings.ts";

describe("feature rings", () => {
	it("sub-agents sit evenly spaced on the ring around the group's centre", () => {
		const c = { x: 10, y: 20 };
		const slots = ringSlots(c, 30, 4, 0);
		assert.equal(slots.length, 4);
		for (const s of slots) assert.ok(Math.abs(Math.hypot(s.x - c.x, s.y - c.y) - 30) < 1e-9);
		assert.ok(Math.abs(slots[0]!.x - 40) < 1e-9 && Math.abs(slots[1]!.y - 50) < 1e-9, "quarter turns");
		const five = ringSlots(c, 30, 5, 0.3);
		const gap = (i: number) => Math.hypot(five[i]!.x - five[(i + 1) % 5]!.x, five[i]!.y - five[(i + 1) % 5]!.y);
		assert.ok(Math.abs(gap(0) - gap(3)) < 1e-9, "equal chords");
		assert.deepEqual(ringSlots(c, 30, 0, 0), []);
	});

	it("a trail starts at the centre for the chat and at the icon for a sub-agent", () => {
		const centre = { x: 1, y: 2 };
		const icon = { x: 31, y: 2 };
		assert.deepEqual(trailOrigin("chat", centre, icon), centre);
		assert.deepEqual(trailOrigin("sub", centre, icon), icon);
		assert.deepEqual(trailOrigin("sub", centre, undefined), centre, "a sub-agent already gone falls back to the centre");
	});

	it("the chat pulls the group strongly and a sub-agent mostly moves itself", () => {
		const T = { x: 100, y: 0 };
		const chat = pullFor("chat", { x: 0, y: 0 }, { x: 0, y: 0 }, T, LIVE_TUNING);
		assert.ok(Math.abs(chat.group.x - 56) < 1e-9, "0.70 pull x 0.8 reach of the distance");
		assert.equal(chat.self, undefined);
		assert.ok(Math.abs(chat.group.holdSec - 33) < 1e-9, "1.1 x the 30 s pace");
		const sub = pullFor("sub", { x: 0, y: 0 }, { x: 10, y: 0 }, T, LIVE_TUNING);
		assert.ok(Math.abs(sub.self!.x - 48.6) < 1e-9, "0.60 x 0.9 of the distance from the icon");
		assert.ok(Math.abs(sub.group.x - 4.2) < 1e-9, "the group only drifts");
		assert.ok(sub.self!.x > sub.group.x * 10 && chat.group.x > sub.group.x * 10);
		assert.ok(sub.self!.holdSec < chat.group.holdSec);
	});

	it("sub-agents orbit their feature: the angle advances at the tuned rate, spacing stays even, the ring follows a moving feature, reduced motion is static", () => {
		assert.equal(LIVE_TUNING.orbitSec, 14);
		const turn = Math.PI * 2;
		assert.ok(Math.abs(orbitPhase(8000, 14, false) - orbitPhase(1000, 14, false) - (turn * 7) / 14) < 1e-9, "7 s is half a revolution");
		for (let n = 1; n <= 5; n++) {
			const at = (ms: number, c: { x: number; y: number }) => ringSlots(c, 20, n, 0.4 + orbitPhase(ms, 14, false));
			const a = at(3000, { x: 0, y: 0 });
			const b = at(9100, { x: 50, y: -30 });
			for (const s of b) assert.ok(Math.abs(Math.hypot(s.x - 50, s.y + 30) - 20) < 1e-9, "still on the ring around the moved feature");
			if (n > 1) {
				const chord = 2 * 20 * Math.sin(Math.PI / n);
				for (let i = 0; i < n; i++) assert.ok(Math.abs(Math.hypot(b[i]!.x - b[(i + 1) % n]!.x, b[i]!.y - b[(i + 1) % n]!.y) - chord) < 1e-9, `even spacing with ${n}`);
				assert.ok(Math.hypot(a[0]!.x - (b[0]!.x - 50), a[0]!.y - (b[0]!.y + 30)) > 1, "they have turned");
			}
		}
		assert.equal(orbitPhase(123456, 14, true), 0);
		assert.equal(orbitPhase(999999, 14, true), 0);
	});

	it("an elastic offset stretches toward its goal and snaps back to zero when the goal clears", () => {
		const b = { x: 0, y: 0, vx: 0, vy: 0 };
		for (let i = 0; i < 300; i++) elasticStep(b, 40, 0, 18 / 30, 2.2, 0.05);
		assert.ok(Math.abs(b.x - 40) < 1, `stretched (${b.x})`);
		for (let i = 0; i < 400; i++) elasticStep(b, 0, 0, 18 / 30, 2.2, 0.05);
		assert.ok(Math.abs(b.x) < 0.5, `snapped back (${b.x})`);
	});
});
