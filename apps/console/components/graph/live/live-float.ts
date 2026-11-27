/**
 * The idle float of wolves and subagents: a slow, smooth drift so the pack never sits dead still. A pure function of time (computed
 * from the timestamp, never integrated per frame), so any frame rate shows the same path and a missed frame costs nothing.
 *
 * Each axis is two sines at different periods (4-7 s, from the entity's name hash) with phases from the hash. The offset is bounded by
 * `amp` on each axis. Reduced motion: zero.
 */
export interface FloatOffset { dx: number; dy: number }
const ZERO: FloatOffset = { dx: 0, dy: 0 };

/** Stable non-negative hash of a name (the same one the overlay uses for home angles). */
export function nameHash(s: string): number {
	let h = 7;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return Math.abs(h);
}

const TAU = Math.PI * 2;
/** Period in ms for the n-th sine of an axis: 4000-7000 ms from the hash. */
const period = (h: number, n: number) => 4000 + ((h >>> (n * 3)) % 3001);
const phase = (h: number, n: number) => (((h >>> (n * 5 + 1)) % 628) / 100) % TAU;

/**
 * Offset of an entity at epoch/monotonic time `tMs`. `amp` is the bound on each axis (any unit); `slow` stretches the periods
 * (offline wolves float slower). Reduced motion or a non-positive amp: no offset.
 */
export function floatOffset(hash: number, tMs: number, amp: number, opts: { reduced?: boolean; slow?: number } = {}): FloatOffset {
	if (opts.reduced || !(amp > 0)) return ZERO;
	const s = opts.slow && opts.slow > 0 ? opts.slow : 1;
	const t = tMs / s;
	const ax = 0.6 * Math.sin((TAU * t) / period(hash, 0) + phase(hash, 0)) + 0.4 * Math.sin((TAU * t) / period(hash, 2) + phase(hash, 2));
	const ay = 0.6 * Math.sin((TAU * t) / period(hash, 1) + phase(hash, 1)) + 0.4 * Math.sin((TAU * t) / period(hash, 3) + phase(hash, 3));
	return { dx: amp * ax, dy: amp * ay };
}
