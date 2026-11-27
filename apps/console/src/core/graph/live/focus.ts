/**
 * A wolf's FOCUS nodes (pure): the KB entries and work items its home thread read or wrote recently. They pull the wolf toward them
 * (live-den orbitTarget) until the trail time passes; at most FOCUS_MAX are kept, the oldest dropped first.
 */
export interface FocusTouch { id: string; at: number }
export const FOCUS_MAX = 4;

/** Map node ids that count as a focus: an entry or a work item (not the domain / section fallbacks). */
export const isFocusNode = (id: string): boolean => id.startsWith("ent:") || id.startsWith("work:");

/** Record a touch: a repeat refreshes the node, then the list is capped to the newest FOCUS_MAX. */
export function touchFocus(list: readonly FocusTouch[], id: string, at: number): FocusTouch[] {
	const next = list.filter((f) => f.id !== id);
	next.push({ id, at });
	return next.slice(-FOCUS_MAX);
}

/** The ids still within `ttlMs` of `now`, oldest first. */
export function activeFocus(list: readonly FocusTouch[], now: number, ttlMs: number): string[] {
	return list.filter((f) => now - f.at <= ttlMs).map((f) => f.id);
}
