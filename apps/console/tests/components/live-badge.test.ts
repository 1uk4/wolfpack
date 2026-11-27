import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LIVE_TUNING } from "../../components/graph/live/live-tuning.ts";
import { badgeLook, badgeRadiusPx, badgeRing, parkingSpot, stateRingRadiusPx, subOrbitRadiusPx, subRadiusPx } from "../../components/graph/live/live-badge.ts";

const T = LIVE_TUNING;

describe("avatar badge state ring (work-wolfpack-1Djd6IR)", () => {
	it("resting has no ring, working a ~90 degree arc, needs-you a full amber pulsing ring, offline is dimmed with none", () => {
		assert.deepEqual(badgeRing({ online: true, working: false, needsYou: false }, T), { kind: "none", amber: false, sweepRad: 0, pulse: false, dim: false });
		const w = badgeRing({ online: true, working: true, needsYou: false }, T);
		assert.equal(w.kind, "arc");
		assert.equal(w.amber, false);
		assert.ok(Math.abs(w.sweepRad - Math.PI / 2) < 1e-9);
		assert.deepEqual(badgeRing({ online: true, working: true, needsYou: true }, T), { kind: "full", amber: true, sweepRad: Math.PI * 2, pulse: true, dim: false });
		assert.deepEqual(badgeRing({ online: false, working: true, needsYou: false }, T), { kind: "none", amber: false, sweepRad: 0, pulse: false, dim: true });
	});

	it("the home wolf is 34 px (38 phone), a feature thread 24 px (28 phone), a sub-agent 14 px (16 phone), and the ring hugs its badge with a 3 px gap and a 2.5 px stroke", () => {
		assert.equal(badgeRadiusPx(false, T, "home"), 17);
		assert.equal(badgeRadiusPx(true, T, "home"), 19);
		assert.equal(badgeRadiusPx(false, T, "feature"), 12);
		assert.equal(badgeRadiusPx(true, T, "feature"), 14);
		assert.equal(subRadiusPx(false, T), 7);
		assert.equal(subRadiusPx(true, T), 8);
		assert.equal(stateRingRadiusPx(false, T, "feature"), 12 + 3 + 1.25);
		assert.equal(stateRingRadiusPx(false, T, "home"), 17 + 3 + 1.25);
		assert.equal(subOrbitRadiusPx(false, T, "feature"), 12 + 7 + 1); // pushed out so the disc clears the badge
		assert.equal(subOrbitRadiusPx(true, T, "feature"), 14 + 8 + 1);
	});

	it("the home wolf is a solid vibrant disc with a quiet 8 px glow and no border; a feature thread is a translucent disc with a solid hairline border and no glow", () => {
		assert.deepEqual(badgeLook("home", T), { fillAlpha: 1, glowPx: 8, border: false });
		assert.deepEqual(badgeLook("feature", T), { fillAlpha: 0.55, glowPx: 0, border: true });
	});
});

describe("parking beside the target", () => {
	it("settles on the side it came from at badge + node radius + 10 px, never on the target", () => {
		const k = 2; // 2 screen px per world unit
		const p = parkingSpot({ x: 100, y: 50 }, { x: 0, y: 50 }, 6, 14, 10, k);
		assert.ok(Math.abs(p.x - (100 - (14 + 6 + 10) / k)) < 1e-9);
		assert.equal(p.y, 50);
		const onTop = parkingSpot({ x: 5, y: 5 }, { x: 5, y: 5 }, 6, 14, 10, k);
		assert.ok(Math.hypot(onTop.x - 5, onTop.y - 5) * k >= 30 - 1e-9, "coming from the target itself still leaves a gap");
	});
});

