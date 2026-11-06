/**
 * THREAD COLORS (pure, browser-safe). Every thread has a color with no setup: a stable hash of its id picks one of the
 * fixed palette's 8 colors (the same FNV-1a the KB graph uses for domain hues). The owner can override it (a palette
 * key in the thread's settings); a subagent thread shows its parent's color (the parent's override, else its automatic one).
 */
import { THREAD_COLORS, THREAD_COLOR_KEYS, type ThreadColor } from "@wolfpack/protocol";
import { hashString } from "./kb-graph-model.ts";

export { THREAD_COLORS, THREAD_COLOR_KEYS };
export type { ThreadColor };

/** The thread fields the color needs; a ThreadSummary, a sidebar row or a palette entry all fit. */
export interface ThreadColorSource {
	id: string;
	parentThreadId?: string;
	/** The owner's override: a ThreadSummary's `settings`. */
	settings?: object;
	/** The override as a flat field (sidebar rows). */
	color?: string | null;
}

export interface ThreadColorInfo {
	key: ThreadColor;
	hex: string;
	/** True when the owner picked it (here or on the parent), false when derived from the id. */
	overridden: boolean;
}

/** The override a thread carries: its settings' color wins; the flat row field is the fallback (settings.color null/absent falls through). */
const colorOf = (t: ThreadColorSource | undefined): unknown => {
	const fromSettings = (t?.settings as { color?: unknown } | undefined)?.color;
	return fromSettings !== undefined && fromSettings !== null ? fromSettings : t?.color;
};
const isKey = (v: unknown): v is ThreadColor => typeof v === "string" && (THREAD_COLOR_KEYS as readonly string[]).includes(v);

/** The automatic color for an id: the same id always gives the same one of the 8. */
export function autoThreadColor(id: string): ThreadColor {
	return THREAD_COLOR_KEYS[hashString(id) % THREAD_COLOR_KEYS.length]!;
}

const info = (key: ThreadColor, overridden: boolean): ThreadColorInfo => ({ key, hex: THREAD_COLORS[key], overridden });

/**
 * The thread's color. `all` is the known threads (to find a subagent's parent for its override); a parent not in `all`
 * still gives its automatic color, because that depends on the id alone.
 */
export type ThreadColorIndex = ReadonlyMap<string, ThreadColorSource>;
/** Build the parent lookup once (per render) instead of scanning the list per row. */
export function threadColorIndex(all: readonly ThreadColorSource[]): ThreadColorIndex {
	return new Map(all.map((t) => [t.id, t] as const));
}

export function threadColor(thread: ThreadColorSource, all: readonly ThreadColorSource[] | ThreadColorIndex = []): ThreadColorInfo {
	const own = colorOf(thread);
	if (thread.parentThreadId !== undefined) {
		const parent = Array.isArray(all) ? all.find((t) => t.id === thread.parentThreadId) : (all as ThreadColorIndex).get(thread.parentThreadId);
		const pc = colorOf(parent);
		return isKey(pc) ? info(pc, true) : info(autoThreadColor(thread.parentThreadId), false);
	}
	return isKey(own) ? info(own, true) : info(autoThreadColor(thread.id), false);
}

/** The tint as an opaque color over the page background (for the fade and the composer dock, which sit over content). */
export function threadTintSolid(hex: string): string {
	return `color-mix(in srgb, ${hex} 5%, var(--background))`;
}

/** A faint background tint for the chat surface (the hex at low alpha). */
export function threadTint(hex: string): string {
	return `color-mix(in srgb, ${hex} 5%, transparent)`;
}
