/**
 * THE FLOATING CHAT BAR's pure model: which thread the bar is attached to, how that falls back to the owner's home
 * thread, and the switcher's list. PURE: no React, no IO (storage is injected).
 */

import { threadHref, threadSlug } from "./thread-adapter.ts";

/** The one thread the bar talks to. `threadId` is the client's id (the draft key uses it); `slug` is the URL/route form. */
export interface AttachedRef {
	wolf: string;
	slug: string;
	threadId: string;
}

export interface ChatBarState {
	attached: AttachedRef | null;
	minimized: boolean;
	/** A one-line note after a fallback ("<title> is gone; back on <wolf>'s home thread"). Cleared by the next attach. */
	note: string | null;
}

export const ATTACHED_KEY = "wolfpack:chatbar:attached";
export const MINIMIZED_KEY = "wolfpack:chatbar:minimized";
/** The owner's "Home wolf" setting (a wolf name); absent = the guess in {@link pickOwnerWolf}. Stored on this device, like the shortcut overrides. */
export const HOME_WOLF_KEY = "wolfpack:chatbar:home-wolf";

export function loadHomeWolf(s: KeyValueStore | null): string | null {
	try {
		return s?.getItem(HOME_WOLF_KEY)?.trim() || null;
	} catch {
		return null;
	}
}

/** null (or empty) resets to the default. */
export function saveHomeWolf(s: KeyValueStore | null, wolf: string | null): void {
	try {
		if (!s) return;
		if (wolf?.trim()) s.setItem(HOME_WOLF_KEY, wolf.trim());
		else s.removeItem(HOME_WOLF_KEY);
	} catch {
		/* best effort */
	}
}

export interface KeyValueStore {
	getItem(k: string): string | null;
	setItem(k: string, v: string): void;
	removeItem(k: string): void;
}

export function loadAttached(s: KeyValueStore | null): AttachedRef | null {
	try {
		const raw = s?.getItem(ATTACHED_KEY);
		if (!raw) return null;
		const v = JSON.parse(raw) as Partial<AttachedRef>;
		return typeof v.wolf === "string" && typeof v.slug === "string" && typeof v.threadId === "string" && v.wolf && v.slug ? { wolf: v.wolf, slug: v.slug, threadId: v.threadId } : null;
	} catch {
		return null;
	}
}

export function saveAttached(s: KeyValueStore | null, ref: AttachedRef | null): void {
	try {
		if (!s) return;
		if (ref) s.setItem(ATTACHED_KEY, JSON.stringify(ref));
		else s.removeItem(ATTACHED_KEY);
	} catch {
		/* best effort */
	}
}

export function loadMinimized(s: KeyValueStore | null): boolean {
	try {
		return s?.getItem(MINIMIZED_KEY) === "1";
	} catch {
		return false;
	}
}

export function saveMinimized(s: KeyValueStore | null, v: boolean): void {
	try {
		if (!s) return;
		if (v) s.setItem(MINIMIZED_KEY, "1");
		else s.removeItem(MINIMIZED_KEY);
	} catch {
		/* best effort */
	}
}

/** A thread as the bar reads it from a wolf's thread list. */
export interface BarThread {
	id: string;
	title: string;
	kind?: string;
	status?: "idle" | "busy" | "needs-you";
	closed?: boolean;
	parentThreadId?: string;
	settings?: { color?: string };
}

export interface WolfLite {
	name: string;
	status?: string;
	librarian?: boolean;
}

/**
 * The owner's own wolf: the console has no explicit "owner" flag, so it is the first ONLINE wolf that is not the
 * librarian (the librarian serves the KB; the owner's working wolf is the other), else the first online wolf.
 * Null when none is online.
 */
export function pickOwnerWolf(wolves: readonly WolfLite[]): string | null {
	const online = wolves.filter((w) => w.status !== "offline");
	return (online.find((w) => !w.librarian) ?? online[0])?.name ?? null;
}

/**
 * The wolf whose home thread the bar falls back to. The console has NO reliable signal for the wolf it runs as (a wolf
 * summary carries only id/name/host/status/librarian; WOLFPACK_API_URL names no wolf), so the default stays the
 * {@link pickOwnerWolf} guess. The owner's setting, when present, wins even if that wolf is offline or unknown.
 */
export function resolveHomeWolf(setting: string | null | undefined, wolves: readonly WolfLite[]): string | null {
	return setting?.trim() || pickOwnerWolf(wolves);
}

/** A wolf's home thread (kind "home", not archived). */
export function homeThread(threads: readonly BarThread[]): BarThread | undefined {
	return threads.find((t) => t.kind === "home" && !t.closed);
}

/** Can the bar attach to this thread? Subagent/process threads, children and archived threads cannot. */
export const attachable = (t: BarThread): boolean => (t.kind === "home" || t.kind === "feature") && !t.parentThreadId && !t.closed;

export type ThreadsByWolf = Record<string, readonly BarThread[] | undefined>;

export interface Resolution {
	attached: AttachedRef | null;
	note: string | null;
}

/**
 * Settle the stored target against what exists. A wolf whose list is unknown (offline, fetch failed) is not "gone":
 * the stored target stands. A target that is missing or archived on a wolf whose list is known falls back to the owner
 * wolf's home thread with a note; with no stored target at all it is the home thread, no note.
 */
export function resolveAttached(stored: AttachedRef | null, wolves: readonly WolfLite[], threads: ThreadsByWolf, homeWolfSetting: string | null = null): Resolution {
	if (stored) {
		const list = threads[stored.wolf];
		if (!list) return { attached: stored, note: null };
		const hit = list.find((t) => t.id === stored.threadId);
		if (hit && !hit.closed) return { attached: stored, note: null };
	}
	// A home wolf that is offline or unknown has no thread list: nothing to jump to, the stored target stays.
	const owner = resolveHomeWolf(homeWolfSetting, wolves);
	const ownerList = owner ? threads[owner] : undefined;
	const home = owner && ownerList ? homeThread(ownerList) : undefined;
	if (!owner || !home) return { attached: stored, note: null };
	const fallback: AttachedRef = { wolf: owner, slug: threadSlug(owner, home.id), threadId: home.id };
	return { attached: fallback, note: stored ? "The attached thread is gone or archived; back on the home thread." : null };
}

export interface SwitcherEntry {
	wolf: string;
	threadId: string;
	slug: string;
	title: string;
	kind: "home" | "feature";
	status: "idle" | "busy" | "needs-you";
	href: string;
}

export interface SwitcherGroup {
	wolf: string;
	entries: SwitcherEntry[];
}

/** Recent feature threads the switcher shows per wolf, besides its home thread and every needs-you thread. Owner decision: 6, no search. */
export const SWITCHER_RECENT = 6;

/**
 * The switcher list, GROUPED BY WOLF: per wolf the home thread first, then threads that need the owner, then the
 * recent feature threads (the list is newest-last on the wire; the newest come first here). Subagent/process threads,
 * children and archived threads are excluded. Wolves without an attachable thread are omitted; the owner wolf leads.
 */
export function buildSwitcher(wolves: readonly WolfLite[], threads: ThreadsByWolf): SwitcherGroup[] {
	const owner = pickOwnerWolf(wolves);
	const groups: SwitcherGroup[] = [];
	for (const w of wolves) {
		const list = threads[w.name];
		if (!list) continue;
		const ok = list.filter(attachable);
		const entry = (t: BarThread): SwitcherEntry => ({
			wolf: w.name,
			threadId: t.id,
			slug: threadSlug(w.name, t.id),
			title: t.kind === "home" ? w.name : t.title,
			kind: t.kind === "home" ? "home" : "feature",
			status: t.status ?? "idle",
			href: threadHref(w.name, t.id),
		});
		const home = ok.filter((t) => t.kind === "home");
		const features = ok.filter((t) => t.kind !== "home").reverse();
		const needs = features.filter((t) => t.status === "needs-you");
		const rest = features.filter((t) => t.status !== "needs-you").slice(0, SWITCHER_RECENT);
		const entries = [...home, ...needs, ...rest].map(entry);
		if (entries.length) groups.push({ wolf: w.name, entries });
	}
	return groups.sort((a, b) => Number(b.wolf === owner) - Number(a.wolf === owner));
}
