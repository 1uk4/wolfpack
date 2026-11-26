/**
 * WOLF-TO-HUB SPRINGS (pure, invisible): each wolf has a spring to every one of its feature-thread hubs, and a weak spring to its ring slot.
 * The rest position of those springs is the weighted mean, so the wolf settles near the rough centre of its features, not on any one hub:
 *
 *   anchor = (HOME_K * slot + HUB_K * (sum of hubs)) / (HOME_K + n * HUB_K), the pull toward the centre capped at MAX_PULL.
 *
 * One hub pulls halfway, two two-thirds, three three-quarters, four and up four-fifths. No hubs (or a non-finite sum): the slot, unchanged.
 * Writes into `out` (no allocation per frame).
 */
export const WOLF_HOME_K = 1;
export const WOLF_HUB_K = 1;
export const WOLF_MAX_PULL = 0.8;

export function wolfSpringAnchor(slotX: number, slotY: number, hubSumX: number, hubSumY: number, hubCount: number, out: { x: number; y: number }): { x: number; y: number } {
	if (hubCount <= 0 || !Number.isFinite(hubSumX) || !Number.isFinite(hubSumY)) {
		out.x = slotX;
		out.y = slotY;
		return out;
	}
	const pull = Math.min((hubCount * WOLF_HUB_K) / (WOLF_HOME_K + hubCount * WOLF_HUB_K), WOLF_MAX_PULL);
	out.x = slotX + (hubSumX / hubCount - slotX) * pull;
	out.y = slotY + (hubSumY / hubCount - slotY) * pull;
	return out;
}
