/**
 * One-time re-centre of a layout that sits off the origin.
 *
 * The live sim and the depth anchor pull toward the origin. A healthy layout
 * that is stored off-centre (or one that drifted) would slide as a whole on
 * the first drag or reheat. So when the data loads, the layout is translated
 * so its centroid is the origin and the camera is shifted by the same world
 * offset: the picture on screen does not change, and the pull has nothing
 * left to move.
 */

export interface Point {
	x: number;
	y: number;
}

/** Centroid further than this (world units) is always re-centred. */
export const RECENTRE_MIN_DISTANCE = 200;
/** Centroid further than this share of the bbox span is re-centred. */
export const RECENTRE_SPAN_SHARE = 0.1;

/**
 * The world offset to subtract from every position, or null when the layout
 * is close enough to the origin to leave alone (centroid within 10% of the
 * bbox span and within 200 units).
 */
export function recentreOffset(points: readonly Point[]): Point | null {
	if (points.length === 0) return null;
	let sx = 0;
	let sy = 0;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
		sx += p.x;
		sy += p.y;
		if (p.x < minX) minX = p.x;
		if (p.x > maxX) maxX = p.x;
		if (p.y < minY) minY = p.y;
		if (p.y > maxY) maxY = p.y;
	}
	const c = { x: sx / points.length, y: sy / points.length };
	const dist = Math.hypot(c.x, c.y);
	const span = Math.max(maxX - minX, maxY - minY);
	if (dist <= RECENTRE_MIN_DISTANCE && dist <= RECENTRE_SPAN_SHARE * span) return null;
	return c;
}

/** Positions shifted by minus `offset` (a new array; relative distances kept). */
export function translatePoints<T extends Point>(points: readonly T[], offset: Point): T[] {
	return points.map((p) => ({ ...p, x: p.x - offset.x, y: p.y - offset.y }));
}

/**
 * The camera (screen = world * k + translate) that shows the translated
 * world exactly as `camera` showed the original: a world point p moved to
 * p - offset lands on the same screen point.
 */
export function recentreCamera(
	camera: { x: number; y: number; k: number },
	offset: Point,
): { x: number; y: number; k: number } {
	return { k: camera.k, x: camera.x + offset.x * camera.k, y: camera.y + offset.y * camera.k };
}
