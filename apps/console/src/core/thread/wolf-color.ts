/**
 * WOLF COLOUR TOKENS (pure, browser-safe). The ONE place a wolf's colour key (wolf.yaml `color`, a THREAD_COLOR_KEYS key)
 * becomes UI colours: a faint `tint` for backgrounds and a solid `accent`, each for the light and the dark theme.
 * Surfaces read the CSS variables `--wolf-tint` and `--wolf-accent` that `wolfColorStyle` produces (theme-aware through
 * CSS `light-dark()`, which follows the page's `color-scheme`). A wolf with no (or an unknown) colour gets the neutral
 * pair: no tint, the app's own accent, so nothing changes for it.
 *
 * Dark accents are the palette colours themselves (THREAD_COLORS). Light accents are darker shades of the same hues, so
 * they stay readable on a light page. Tints are the accent at 6% (dark) / 7% (light) alpha: text contrast is unchanged.
 */
import { THREAD_COLORS, THREAD_COLOR_KEYS, type ThreadColor } from "@wolfpack/protocol";
import { threadColor } from "./thread-color.ts";

export interface WolfColorPair {
	/** A faint background colour (low alpha), meant to be layered over the page background. */
	tint: string;
	/** A solid colour for borders, dots and highlights. */
	accent: string;
}
export interface WolfColorTokens {
	light: WolfColorPair;
	dark: WolfColorPair;
}

/** Light-theme accents: the palette hues, darkened to read on a light page. */
const LIGHT_ACCENTS: Record<ThreadColor, string> = {
	red: "#c93a45",
	orange: "#c46a1a",
	yellow: "#9a7d00",
	green: "#3f8f2f",
	teal: "#6b9a10",
	blue: "#1f6fc0",
	purple: "#6f4fd0",
	pink: "#c43a8a",
};

const DARK_ALPHA = 0.06;
const LIGHT_ALPHA = 0.07;

const NEUTRAL: WolfColorTokens = {
	light: { tint: "transparent", accent: "var(--primary)" },
	dark: { tint: "transparent", accent: "var(--primary)" },
};

const isKey = (v: unknown): v is ThreadColor => typeof v === "string" && (THREAD_COLOR_KEYS as readonly string[]).includes(v);

function rgba(hex: string, alpha: number): string {
	const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
	return `rgba(${n(1)}, ${n(3)}, ${n(5)}, ${alpha})`;
}

/**
 * THE effective colour key of a wolf: its wolf.yaml `color` when set (and valid), else the automatic colour the app already
 * shows for it (the den strip's: a hash of its home thread id, `<name>/home` when the id is not known). Every surface
 * (chat bar, thread page, den strip, map) takes the wolf's colour from here so they agree.
 */
export function effectiveWolfColor(wolf: { name: string; color?: string | null }, homeThreadId?: string): ThreadColor {
	return threadColor({ id: homeThreadId ?? `${wolf.name}/home`, kind: "home" }, [], wolf.color).key;
}

/** True when the key names a palette colour (the wolf has a colour of its own). */
export const hasWolfColor = isKey;

/** The light and dark {tint, accent} for a wolf's colour key; the neutral pair for a missing or unknown key. */
export function wolfColorTokens(key?: string | null): WolfColorTokens {
	if (!isKey(key)) return NEUTRAL;
	const dark = THREAD_COLORS[key];
	const light = LIGHT_ACCENTS[key];
	return {
		light: { tint: rgba(light, LIGHT_ALPHA), accent: light },
		dark: { tint: rgba(dark, DARK_ALPHA), accent: dark },
	};
}

/** The CSS variables a surface sets on its root: `--wolf-tint` and `--wolf-accent`, each `light-dark(light, dark)`. */
export function wolfColorStyle(key?: string | null): Record<"--wolf-tint" | "--wolf-accent", string> {
	const t = wolfColorTokens(key);
	return {
		"--wolf-tint": t === NEUTRAL ? "transparent" : `light-dark(${t.light.tint}, ${t.dark.tint})`,
		"--wolf-accent": t === NEUTRAL ? "var(--primary)" : `light-dark(${t.light.accent}, ${t.dark.accent})`,
	};
}
