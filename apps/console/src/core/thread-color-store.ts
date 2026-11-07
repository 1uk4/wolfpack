/**
 * THE THREAD-COLOR STORE (tiny module-level emitter, browser-safe): the one place a color pick is announced, so the
 * thread settings menu, the sidebar, the open thread's tint and the floating bar all agree at once.
 *
 *  - `beginColorChange` records the pick as pending (an optimistic value that a list poll must not undo) and announces it.
 *  - `settleColorChange` ends it. Only the LATEST change of a thread settles it (a stale call's outcome is ignored, so an
 *    older failure can never roll back a newer pick). Success re-announces the value (re-applying it over any poll that
 *    landed mid-request); failure announces the value from before.
 *  - `knownColor` is the last announced value per thread (null = reset to automatic), for views with no poll.
 */
export type ColorValue = string | null;
type Listener = (id: string, color: ColorValue) => void;

const listeners = new Set<Listener>();
const pending = new Map<string, { color: ColorValue; seq: number; prev: ColorValue }>();
const known = new Map<string, ColorValue>();
let seqCounter = 0;
let version = 0;

function emit(id: string, color: ColorValue): void {
	known.set(id, color);
	version++;
	for (const l of [...listeners]) l(id, color);
}

export function onThreadColor(fn: Listener): () => void {
	listeners.add(fn);
	return () => void listeners.delete(fn);
}
/** Bumps on every announcement (for useSyncExternalStore). */
export const threadColorVersion = (): number => version;
export const pendingColor = (id: string): { color: ColorValue } | undefined => {
	const p = pending.get(id);
	return p ? { color: p.color } : undefined;
};
export const knownColor = (id: string): { color: ColorValue } | undefined => (known.has(id) ? { color: known.get(id) as ColorValue } : undefined);

/** Start a change. `current` is the value the thread shows now (used to roll back when this is the first pending change). */
export function beginColorChange(id: string, color: ColorValue, current: ColorValue): number {
	const seq = ++seqCounter;
	// A change made while another is in flight rolls back to what that one was going to show.
	const prev = pending.get(id)?.color ?? current;
	pending.set(id, { color, seq, prev });
	emit(id, color);
	return seq;
}

/** End a change. Returns whether it was the latest (and so acted on). */
export function settleColorChange(id: string, seq: number, ok: boolean): boolean {
	const p = pending.get(id);
	if (!p || p.seq !== seq) return false;
	pending.delete(id);
	emit(id, ok ? p.color : p.prev);
	return true;
}

/** Test seam. */
export function resetThreadColorStore(): void {
	listeners.clear();
	pending.clear();
	known.clear();
	version = 0;
}
