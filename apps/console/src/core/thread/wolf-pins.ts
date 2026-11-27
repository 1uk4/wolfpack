/** Per-browser pin / hide of wolves in the sessions sidebar (presentation only; nothing goes to the server). */
import { rowWolf } from "./subagents.ts";

export type WolfPrefs = { pinned: string[]; hidden: string[] };
export type WolfPrefsStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };

export const WOLF_PREFS_KEY = "wolfpack:sidebar-wolf-prefs";

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Storage can throw in sandboxed contexts, and hold junk: both read as "nothing pinned or hidden". */
export function loadWolfPrefs(store: WolfPrefsStore | undefined): WolfPrefs {
	try {
		const raw = store?.getItem(WOLF_PREFS_KEY);
		const j = raw ? (JSON.parse(raw) as Partial<WolfPrefs>) : {};
		return { pinned: strings(j.pinned), hidden: strings(j.hidden) };
	} catch {
		return { pinned: [], hidden: [] };
	}
}

export function saveWolfPrefs(store: WolfPrefsStore | undefined, prefs: WolfPrefs): void {
	try {
		store?.setItem(WOLF_PREFS_KEY, JSON.stringify(prefs));
	} catch {
		/* storage unavailable: the choice lasts until reload */
	}
}

export function togglePinned(p: WolfPrefs, wolf: string): WolfPrefs {
	return { pinned: p.pinned.includes(wolf) ? p.pinned.filter((w) => w !== wolf) : [...p.pinned, wolf], hidden: p.hidden.filter((w) => w !== wolf) };
}

/** Hiding a pinned wolf unpins it: a wolf is in one place. */
export function toggleHidden(p: WolfPrefs, wolf: string): WolfPrefs {
	return { pinned: p.pinned.filter((w) => w !== wolf), hidden: p.hidden.includes(wolf) ? p.hidden.filter((w) => w !== wolf) : [...p.hidden, wolf] };
}

/** Moves a wolf into the Den (idempotent; unpins it). */
export function hideWolf(p: WolfPrefs, wolf: string): WolfPrefs {
	return p.hidden.includes(wolf) ? p : toggleHidden(p, wolf);
}

/** Takes a wolf out of the Den (idempotent). */
export function showWolf(p: WolfPrefs, wolf: string): WolfPrefs {
	return p.hidden.includes(wolf) ? toggleHidden(p, wolf) : p;
}

/** The Den badge: how many threads of Den wolves wait on the owner. */
export function denNeedsYou(rows: readonly { id: string; meta?: string; needsYou?: boolean }[], prefs: WolfPrefs): number {
	return rows.filter((r) => r.needsYou === true && prefs.hidden.includes(rowWolf(r))).length;
}

/** Splits the sidebar groups by their wolf: pinned (in pin order), hidden, and the rest (original order). */
export function partitionWolves<G extends { top: { id: string; meta?: string } }>(groups: readonly G[], prefs: WolfPrefs): { pinned: G[]; main: G[]; hidden: G[] } {
	const pinned = prefs.pinned.flatMap((w) => groups.filter((g) => rowWolf(g.top) === w));
	const hidden = groups.filter((g) => prefs.hidden.includes(rowWolf(g.top)));
	return { pinned, hidden, main: groups.filter((g) => !prefs.pinned.includes(rowWolf(g.top)) && !prefs.hidden.includes(rowWolf(g.top))) };
}
