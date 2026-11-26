/**
 * The simple graph settings (work-wolfpack-H1OQNIh): the few controls the panel shows up front, expressed on top of the full
 * settings. Pure, no DOM. Everything here only READS and WRITES fields of GraphRenderSettings; the 25 detailed controls stay in
 * the panel's Advanced section and still win: after an Advanced edit the sliders and the preset control re-derive from the settings.
 *
 * SPREAD (0-100, default 50) drives the six physics forces together by one geometric factor f = 2^((n-50)/50), so 0 is half and
 * 100 is double today's defaults, and 50 is EXACTLY the defaults (f = 1; error 0). Each force moves with its own exponent:
 *   repulsion |charge| x f, edge length x f (spread out) ; central pull / f, edge attraction / f, cluster pull / f, friction / sqrt(f).
 * The ends land inside the sweep-validated ranges (charge -120..-480, distance 20..80, gravity .06..24, ...), so no clamp is needed
 * beyond the sanitizer's. Monotonic in n for every force.
 *
 * SOFT REGIONS (0-100, default 50): blur x f, dilation x f, edge alpha / sqrt(f), then snapped to the same ladders the Advanced
 * sliders use (so the stored value is always a ladder stop). 50 is EXACTLY the defaults (dilation 20, blur 40, alpha 0.2).
 * Non-decreasing in n (blur, dilation up; alpha down).
 *
 * The inverses (spreadFromPhysics, softRegionsFromTuning) take the least-squares fit of log2(value / default) against each
 * force's exponent, so an Advanced edit moves the simple slider to the closest position. They are exact at the defaults.
 */

import {
	CHARGE_RANGE,
	DEFAULT_PHYSICS_TUNING,
	DEFAULT_RENDER_SETTINGS,
	DEFAULT_REGION_TUNING,
	GRAVITY_RANGE,
	LABEL_ZOOM_LADDER,
	LINK_DISTANCE_RANGE,
	LINK_STRENGTH_RANGE,
	CLUSTER_PULL_RANGE,
	REGION_BLUR_LADDER,
	REGION_DILATION_LADDER,
	REGION_EDGE_ALPHA_LADDER,
	VELOCITY_DECAY_RANGE,
	snapToLadder,
	type GraphRenderSettings,
	type PhysicsTuning,
	type RegionTuning,
} from "./render-settings.ts";

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const factor = (n: number) => 2 ** ((clamp(Number.isFinite(n) ? n : 50, 0, 100) - 50) / 50);
const D = DEFAULT_PHYSICS_TUNING;

/** Slider position 0-100 -> the six forces (the other physics fields come from `rest`). */
export function spreadToPhysics(n: number, rest: PhysicsTuning = D): PhysicsTuning {
	const f = factor(n);
	return {
		...rest,
		chargeStrength: clamp(D.chargeStrength * f, CHARGE_RANGE.min, CHARGE_RANGE.max),
		linkDistance: clamp(D.linkDistance * f, LINK_DISTANCE_RANGE.min, LINK_DISTANCE_RANGE.max),
		gravity: clamp(D.gravity / f, GRAVITY_RANGE.min, GRAVITY_RANGE.max),
		linkStrength: clamp(D.linkStrength / f, LINK_STRENGTH_RANGE.min, LINK_STRENGTH_RANGE.max),
		clusterPull: clamp(D.clusterPull / f, CLUSTER_PULL_RANGE.min, CLUSTER_PULL_RANGE.max),
		velocityDecay: clamp(D.velocityDecay / Math.sqrt(f), VELOCITY_DECAY_RANGE.min, VELOCITY_DECAY_RANGE.max),
	};
}

/** Least-squares slider position from log2 ratios and their exponents (0..100, exact at all-zero). */
function fit(terms: readonly (readonly [exponent: number, ratio: number])[]): number {
	let num = 0;
	let den = 0;
	for (const [e, r] of terms) {
		num += e * Math.log2(r);
		den += e * e;
	}
	return clamp(50 + 50 * (num / den), 0, 100);
}

/** The slider position that best matches the current forces (50 at the defaults). */
export function spreadFromPhysics(p: PhysicsTuning): number {
	const v = Math.round(
		fit([
			[1, p.chargeStrength / D.chargeStrength],
			[1, p.linkDistance / D.linkDistance],
			[-1, p.gravity / D.gravity],
			[-1, p.linkStrength / D.linkStrength],
			[-1, p.clusterPull > 0 ? p.clusterPull / D.clusterPull : CLUSTER_PULL_RANGE.min / D.clusterPull],
			[-0.5, p.velocityDecay / D.velocityDecay],
		]) * 10,
	);
	return v / 10;
}

const R = DEFAULT_REGION_TUNING;

/** Slider position 0-100 -> dilation, blur and edge alpha (bitmap and enabled come from `rest`). */
export function softRegionsToTuning(n: number, rest: RegionTuning = R): RegionTuning {
	const f = factor(n);
	return {
		...rest,
		dilation: snapToLadder(R.dilation * f, REGION_DILATION_LADDER),
		blur: snapToLadder(R.blur * f, REGION_BLUR_LADDER),
		edgeAlpha: snapToLadder(R.edgeAlpha / Math.sqrt(f), REGION_EDGE_ALPHA_LADDER),
	};
}

/** The slider position that best matches the current region tuning (50 at the defaults). */
export function softRegionsFromTuning(t: RegionTuning): number {
	return Math.round(
		fit([
			[1, t.dilation / R.dilation],
			[1, t.blur / R.blur],
			[-0.5, t.edgeAlpha / R.edgeAlpha],
		]) * 10,
	) / 10;
}

// ─── Labels ──────────────────────────────────────────────────────────────────

const LABEL_ZOOM_FLOOR = LABEL_ZOOM_LADDER[0];

/** Labels are on when the cluster labels show and node labels are not pushed to the ladder floor (they then show only at extreme zoom). */
export function labelsOn(s: GraphRenderSettings): boolean {
	return s.clusterLabels && s.labelZoom > LABEL_ZOOM_FLOOR;
}

/** Off: cluster labels off and node labels at the floor. On: cluster labels on, node labels back to the default zoom when they were at the floor (otherwise left as the user set them). */
export function setLabels(s: GraphRenderSettings, on: boolean): GraphRenderSettings {
	if (!on) return { ...s, clusterLabels: false, labelZoom: LABEL_ZOOM_FLOOR };
	return { ...s, clusterLabels: true, labelZoom: s.labelZoom <= LABEL_ZOOM_FLOOR ? DEFAULT_RENDER_SETTINGS.labelZoom : s.labelZoom };
}

// ─── Presets ─────────────────────────────────────────────────────────────────

export type PresetId = "overview" | "by-domain" | "live";
export const PRESET_IDS: readonly PresetId[] = ["overview", "by-domain", "live"];

/**
 * What each preset sets (everything else is kept):
 *  - overview:  groupBy domain, all domains, labels on at the default zoom and size, regions on and soft (slider 50), spread medium (50).
 *  - by-domain: groupBy domain, cluster labels on, cluster pull doubled to 0.3 (tighter domain clusters); the rest as the user has it.
 *  - live:      the live overlay on, labels lighter (node labels size 2, only from zoom 0.35 in, cluster labels 12 px), cluster labels on.
 */
export function applyPreset(id: PresetId, s: GraphRenderSettings): GraphRenderSettings {
	const d = DEFAULT_RENDER_SETTINGS;
	switch (id) {
		case "overview":
			return {
				...s,
				groupBy: "domain",
				domain: null,
				clusterLabels: true,
				labelZoom: d.labelZoom,
				labelSize: d.labelSize,
				clusterLabelSize: d.clusterLabelSize,
				regions: { ...softRegionsToTuning(50, s.regions), enabled: true },
				physics: spreadToPhysics(50, s.physics),
			};
		case "by-domain":
			return { ...s, groupBy: "domain", clusterLabels: true, physics: { ...s.physics, clusterPull: 0.3 } };
		case "live":
			return {
				...s,
				live: { ...s.live, enabled: true },
				clusterLabels: true,
				labelSize: 2,
				labelZoom: 0.35,
				clusterLabelSize: 12,
			};
	}
}

/** The fields a preset decides; two settings are "the same preset" when these match. */
function projection(id: PresetId, s: GraphRenderSettings): unknown {
	switch (id) {
		case "overview":
			return [s.groupBy, s.domain, s.clusterLabels, s.labelZoom, s.labelSize, s.clusterLabelSize, s.regions.enabled, s.regions.dilation, s.regions.blur, s.regions.edgeAlpha, s.physics.chargeStrength, s.physics.linkDistance, s.physics.gravity, s.physics.linkStrength, s.physics.clusterPull, s.physics.velocityDecay];
		case "by-domain":
			return [s.groupBy, s.clusterLabels, s.physics.clusterPull];
		case "live":
			return [s.live.enabled, s.clusterLabels, s.labelSize, s.labelZoom, s.clusterLabelSize];
	}
}

/** The preset the settings currently match, or "custom" after any manual change to a field a preset sets. */
export function detectPreset(s: GraphRenderSettings): PresetId | "custom" {
	for (const id of PRESET_IDS) {
		if (JSON.stringify(projection(id, applyPreset(id, s))) === JSON.stringify(projection(id, s))) return id;
	}
	return "custom";
}
