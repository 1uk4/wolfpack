/**
 * THE ONE TUNING TABLE for the den, the wolf states and the feature rings (work-wolfpack-LX5JYDd, work-wolfpack-1Djd6IR).
 * Defaults are the owner's concept (frames/polish: p-den and p-rings). Lengths marked "ref px" scale with the overlay's zoom factor `m`.
 */
export interface LiveTuning {
	/** Seconds a wolf (or a feature group's chat pull) takes for a trip: the concept's pace slider (8-60). */
	paceSec: number;
	/** A wolf goes home this long after its last event, or after the idle one once its thread is idle and the turn has ended (seconds). */
	returnAfterEventSec: number;
	returnAfterIdleSec: number;
	/** The den tether strengthens over this long once the wolf has settled (seconds). */
	lingerRampSec: number;
	/** Speed cap of a wolf's trip (ref px per second, on the eased path's peak). */
	maxWolfSpeedPx: number;
	/** Resting orbit: radius (ref px), extra radius for an offline wolf, angular speed (rad/s), breathing amplitude (ref px) and rate (rad/s). */
	restRadiusPx: number;
	restOfflineExtraPx: number;
	restOrbitRadPerSec: number;
	restBreathPx: number;
	restBreathRadPerSec: number;
	/** The den disc (ref px). */
	denRadiusPx: number;
	/** Chat pull: the share of the way to the target the whole group is drawn (pull x reach), held for holdMul x pace. */
	chatPull: number;
	chatReach: number;
	chatHoldMul: number;
	/** Sub-agent pull: the share of the way the sub-agent itself stretches (pull x stretch, from its icon), and how long. */
	subPull: number;
	subStretch: number;
	subHoldMul: number;
	/** While a sub-agent acts the group drifts only this share of the way (x subPull), for groupHoldMul x pace. */
	subGroupDrift: number;
	subGroupHoldMul: number;
	/** Spring rates (1/s at pace 1: divided by the pace): the group's, the sub-agent's elastic tether, and the tether's damping ratio. */
	groupSpring: number;
	subSpring: number;
	subDamping: number;
	/** Avatar badges (screen px, constant at any zoom): diameter of the home wolf and the feature thread on desktop and phone, the gap and stroke of the state ring hugging it, the working arc (degrees) and its turn time (s). */
	homePx: number;
	homePhonePx: number;
	featurePx: number;
	featurePhonePx: number;
	/** Sub-agent badge diameter (screen px) on desktop and phone. */
	subPx: number;
	subPhonePx: number;
	/** The home wolf's soft glow blur (px) and a feature thread's fill opacity. */
	homeGlowPx: number;
	featureFillAlpha: number;
	ringGapPx: number;
	ringStrokePx: number;
	arcDeg: number;
	arcTurnSec: number;
	/** A wolf parks this many screen px (beyond badge + node radius) from its target. */
	parkGapPx: number;
}

export const LIVE_TUNING: LiveTuning = {
	paceSec: 30,
	returnAfterEventSec: 180,
	returnAfterIdleSec: 45,
	lingerRampSec: 45,
	maxWolfSpeedPx: 900,
	restRadiusPx: 62,
	restOfflineExtraPx: 12,
	restOrbitRadPerSec: 0.05,
	restBreathPx: 5,
	restBreathRadPerSec: 1.2,
	denRadiusPx: 20,
	chatPull: 0.7,
	chatReach: 0.8,
	chatHoldMul: 1.1,
	subPull: 0.6,
	subStretch: 0.9,
	subHoldMul: 0.21,
	subGroupDrift: 0.07,
	subGroupHoldMul: 0.24,
	groupSpring: 6,
	subSpring: 18,
	subDamping: 2.2,
	homePx: 34,
	homePhonePx: 38,
	featurePx: 24,
	featurePhonePx: 28,
	subPx: 14,
	subPhonePx: 16,
	homeGlowPx: 8,
	featureFillAlpha: 0.55,
	ringGapPx: 3,
	ringStrokePx: 2.5,
	arcDeg: 90,
	arcTurnSec: 4,
	parkGapPx: 10,
};
