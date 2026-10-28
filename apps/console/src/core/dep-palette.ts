/**
 * Dependency-route drawing constants, in ONE place so a settings surface can
 * expose them later. (Not the command palette: that is palette.ts.)
 */

export interface DepColors {
	/** Every dependency arrow in a visible Factory region (faint context). */
	faintDep: string;
	/** The selected route's arrows and nodes (bright, on top). */
	route: string;
	/** Nodes at a parallel step of the selected route. */
	parallel: string;
	/** The ring on a blocked work item (an unshipped prerequisite). */
	blockedRing: string;
}

export const DEP_COLORS: DepColors = {
	faintDep: "#8a93a6",
	route: "#ffd166",
	parallel: "#06d6a0",
	blockedRing: "#ef476f",
};

/**
 * Dependency arrows draw only at a camera ratio at or below this (ratio =
 * kFit / k: 1 at fit zoom, smaller zoomed in). Tuned a little before the node
 * labels appear (labelZoom default 0.5): you see the Factory's flow just as
 * you zoom into it, and the zoomed-out map stays calm. Change this constant
 * to retune; the draw-list builder takes it as an option.
 */
export const DEP_ARROW_MAX_RATIO = 0.7;

export const DEP_STYLE = {
	/** Arrow shaft width, screen px. */
	faintWidth: 1,
	routeWidth: 2.25,
	/** Opacity of faint arrows and of dimmed (shipped) route nodes. */
	faintAlpha: 0.45,
	doneAlpha: 0.4,
	/** Arrowhead length, screen px. */
	headLength: 7,
	/** Blocked ring: radius multiplier over the node's radius and stroke fraction of radius. */
	blockedRingScale: 1.45,
	blockedRingWeight: 0.14,
	/** Route/parallel node halo ring: radius multiplier. */
	haloScale: 1.3,
	haloWeight: 0.14,
} as const;

/** Weak spring strength along dependency edges inside a Factory (layout). */
export const DEP_SPRING_STRENGTH = 0.03;
