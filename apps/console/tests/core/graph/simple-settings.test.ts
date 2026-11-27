/**
 * Tests for src/core/graph/simple-settings.ts: the Spread and Soft regions slider mappings,
 * the presets and the Labels toggle (work-wolfpack-H1OQNIh).
 */

import assert from "node:assert/strict";
import { describe, it as test } from "node:test";
import {
	DEFAULT_RENDER_SETTINGS,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_REGION_TUNING,
	applyPreset,
	detectPreset,
	labelsOn,
	setLabels,
	softRegionsFromTuning,
	softRegionsToTuning,
	spreadFromPhysics,
	spreadToPhysics,
	sanitizeRenderSettings,
} from "../../../src/core/index.ts";

describe("Spread slider", () => {
	test("the default position (50) reproduces today's physics defaults exactly, and the inverse reads them back as 50", () => {
		assert.deepEqual(spreadToPhysics(50, DEFAULT_PHYSICS_TUNING), DEFAULT_PHYSICS_TUNING);
		assert.equal(spreadFromPhysics(DEFAULT_PHYSICS_TUNING), 50);
	});

	test("more spread pushes nodes apart: repulsion and edge length grow, central pull shrinks; positions clamp to 0..100", () => {
		const lo = spreadToPhysics(0, DEFAULT_PHYSICS_TUNING);
		const mid = spreadToPhysics(50, DEFAULT_PHYSICS_TUNING);
		const hi = spreadToPhysics(100, DEFAULT_PHYSICS_TUNING);
		assert.ok(lo.chargeStrength > mid.chargeStrength && mid.chargeStrength > hi.chargeStrength); // charge is negative
		assert.ok(lo.linkDistance < mid.linkDistance && mid.linkDistance < hi.linkDistance);
		assert.ok(lo.gravity > mid.gravity && mid.gravity > hi.gravity);
		assert.deepEqual(spreadToPhysics(-40, DEFAULT_PHYSICS_TUNING), lo);
		assert.deepEqual(spreadToPhysics(900, DEFAULT_PHYSICS_TUNING), hi);
		// the ends land exactly on the documented ends: charge -120 .. -480, distance 20 .. 80
		assert.equal(lo.chargeStrength, -120);
		assert.equal(hi.chargeStrength, -480);
		assert.equal(lo.linkDistance, 20);
		assert.equal(hi.linkDistance, 80);
	});

	test("the inverse follows the slider: spreadFromPhysics(spreadToPhysics(n)) is n", () => {
		for (const n of [0, 20, 50, 75, 100]) {
			assert.ok(Math.abs(spreadFromPhysics(spreadToPhysics(n, DEFAULT_PHYSICS_TUNING)) - n) < 0.5, `n=${n}`);
		}
	});
});

describe("Soft regions slider", () => {
	test("the default position (50) reproduces the region defaults exactly, and the inverse reads them back as 50", () => {
		const t = softRegionsToTuning(50, DEFAULT_REGION_TUNING);
		assert.equal(t.dilation, 20);
		assert.equal(t.blur, 40);
		assert.equal(t.edgeAlpha, 0.2);
		assert.equal(softRegionsFromTuning(DEFAULT_REGION_TUNING), 50);
	});

	test("softer means wider blur and dilation and a lower edge alpha; it never decreases with the slider", () => {
		let prev = softRegionsToTuning(0, DEFAULT_REGION_TUNING);
		for (let n = 5; n <= 100; n += 5) {
			const cur = softRegionsToTuning(n, DEFAULT_REGION_TUNING);
			assert.ok(cur.blur >= prev.blur && cur.dilation >= prev.dilation && cur.edgeAlpha <= prev.edgeAlpha, `n=${n}`);
			prev = cur;
		}
		assert.ok(softRegionsToTuning(100, DEFAULT_REGION_TUNING).blur > softRegionsToTuning(0, DEFAULT_REGION_TUNING).blur);
		assert.deepEqual(softRegionsToTuning(250, DEFAULT_REGION_TUNING), softRegionsToTuning(100, DEFAULT_REGION_TUNING));
	});
});

describe("presets", () => {
	test("Overview, By domain and Live set the documented values and are detected again; a manual change reads as custom", () => {
		const base = sanitizeRenderSettings({ groupBy: "section", domain: "wolfpack", clusterLabels: false });
		const overview = applyPreset("overview", base);
		assert.equal(overview.groupBy, "domain");
		assert.equal(overview.domain, null);
		assert.equal(overview.clusterLabels, true);
		assert.deepEqual(overview.physics, DEFAULT_PHYSICS_TUNING);
		assert.equal(overview.regions.enabled, true);
		assert.equal(detectPreset(overview), "overview");

		const byDomain = applyPreset("by-domain", base);
		assert.equal(byDomain.groupBy, "domain");
		assert.equal(byDomain.physics.clusterPull, 0.3);
		assert.equal(byDomain.clusterLabels, true);
		assert.equal(detectPreset(byDomain), "by-domain");

		const live = applyPreset("live", sanitizeRenderSettings({ live: { enabled: false } }));
		assert.equal(live.live.enabled, true);
		assert.equal(live.labelSize, 2);
		assert.equal(detectPreset(live), "live");

		assert.equal(detectPreset({ ...overview, nodeSize: 4 }), "overview"); // a knob no preset touches
		assert.equal(detectPreset({ ...overview, clusterLabels: false }), "custom");
		assert.equal(detectPreset({ ...DEFAULT_RENDER_SETTINGS, groupBy: "section" }), "custom");
	});
});

describe("Labels toggle", () => {
	test("off hides cluster and node labels, on restores them, and the state reads back", () => {
		assert.equal(labelsOn(DEFAULT_RENDER_SETTINGS), true);
		const off = setLabels(DEFAULT_RENDER_SETTINGS, false);
		assert.equal(off.clusterLabels, false);
		assert.equal(labelsOn(off), false);
		const on = setLabels(off, true);
		assert.equal(labelsOn(on), true);
		assert.equal(on.labelZoom, DEFAULT_RENDER_SETTINGS.labelZoom);
	});
});

describe("live settings", () => {
	test("old files without a live section get the defaults; bad values clamp", () => {
		assert.deepEqual(sanitizeRenderSettings({}).live, { enabled: true, subagentFadeSec: 15, trailSec: 15, intensity: 1, motion: "follow" });
		assert.deepEqual(sanitizeRenderSettings({ live: { enabled: false, intensity: 9, trailSec: -3 } }).live, {
			enabled: false,
			subagentFadeSec: 15,
			trailSec: 0,
			intensity: 5,
			motion: "follow",
		});
	});
});
