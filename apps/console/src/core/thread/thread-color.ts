/**
 * THREAD COLORS (pure, browser-safe). Every thread has an automatic color: a stable hash of its id picks one of the fixed
 * palette's 8 colors (the same FNV-1a the KB graph uses for domain hues). The one exception is the owner's per-wolf color
 * (wolf.yaml `color`, set in that wolf's Settings): it colors the wolf's home thread, and a subagent takes its parent's
 * color, so the home thread's subagents follow it. Feature threads keep their automatic colors.
 */
import { THREAD_COLORS, THREAD_COLOR_KEYS, type ThreadColor } from "@wolfpack/protocol";
import { hashString } from "../graph/kb-graph-model.ts";

export { THREAD_COLORS, THREAD_COLOR_KEYS };
export type { ThreadColor };

/** The thread fields the color needs; a ThreadSummary, a sidebar row or a palette entry all fit. */
export interface ThreadColorSource {
	id: string;
	kind?: string;
	parentThreadId?: string;
}

export interface ThreadColorInfo {
	key: ThreadColor;
	hex: string;
	/** True when the wolf's own color applies (home thread or its subagent), false when derived from the id. */
	overridden: boolean;
}

const isKey = (v: unknown): v is ThreadColor => typeof v === "string" && (THREAD_COLOR_KEYS as readonly string[]).includes(v);

/** The automatic color for an id: the same id always gives the same one of the 8. */
export function autoThreadColor(id: string): ThreadColor {
	return THREAD_COLOR_KEYS[hashString(id) % THREAD_COLOR_KEYS.length]!;
}

const info = (key: ThreadColor, overridden: boolean): ThreadColorInfo => ({ key, hex: THREAD_COLORS[key], overridden });

/** The known threads, to find a subagent's parent; a parent not in the list still gives its automatic color (it depends on the id alone). */
export type ThreadColorIndex = ReadonlyMap<string, ThreadColorSource>;
/** Build the parent lookup once (per render) instead of scanning the list per row. */
export function threadColorIndex(all: readonly ThreadColorSource[]): ThreadColorIndex {
	return new Map(all.map((t) => [t.id, t] as const));
}

/**
 * The thread's color. `wolfColor` is its wolf's chosen palette key (absent or invalid = automatic). It applies to a home
 * thread, and to a subagent whose parent is the home thread.
 */
export function threadColor(thread: ThreadColorSource, all: readonly ThreadColorSource[] | ThreadColorIndex = [], wolfColor?: string | null): ThreadColorInfo {
	const parentId = thread.parentThreadId;
	if (parentId !== undefined) {
		const parent = Array.isArray(all) ? all.find((t) => t.id === parentId) : (all as ThreadColorIndex).get(parentId);
		return parent?.kind === "home" && isKey(wolfColor) ? info(wolfColor, true) : info(autoThreadColor(parentId), false);
	}
	return thread.kind === "home" && isKey(wolfColor) ? info(wolfColor, true) : info(autoThreadColor(thread.id), false);
}

/** The tint as an opaque color over the page background (for the fade and the composer dock, which sit over content). */
export function threadTintSolid(hex: string): string {
	return `color-mix(in srgb, ${hex} 5%, var(--background))`;
}

/** A faint background tint for the chat surface (the hex at low alpha). */
export function threadTint(hex: string): string {
	return `color-mix(in srgb, ${hex} 5%, transparent)`;
}

/** Readable text on a thread colour: the slate background colour on light colours, white on dark ones (WCAG luminance). */
export function accentForeground(hex: string): string {
	const lin = (i: number) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	const lum = 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
	return lum > 0.18 ? "#0f141a" : "#ffffff";
}

/**
 * The one shared highlight variable. Set on a thread's wrapper (and on its sidebar row) from the thread's colour; with no
 * colour it is teal (`--primary`), which is also what :root defines, so everywhere else stays teal.
 */
export function threadAccentStyle(hex?: string): Record<"--thread-accent" | "--thread-accent-foreground", string> {
	return hex
		? { "--thread-accent": hex, "--thread-accent-foreground": accentForeground(hex) }
		: { "--thread-accent": "var(--primary)", "--thread-accent-foreground": "var(--primary-foreground)" };
}
