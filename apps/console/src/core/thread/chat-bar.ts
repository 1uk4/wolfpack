/**
 * THE FLOATING CHAT BAR's pure model: the popped-out thread (persisted) and the switcher's list. PURE: no React, no IO (storage is injected).
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
}

/** The popped-out thread (the detached chat). A new key: the old "attached" value was the home-wolf default and must not resurrect a bar. */
export const ATTACHED_KEY = "wolfpack:chatbar:popped-out";
/** Pre-detached-chat keys, removed on load so nothing is popped out until the owner pops something out. */
export const LEGACY_KEYS = ["wolfpack:chatbar:attached", "wolfpack:chatbar:home-wolf"] as const; // the second is the removed "Home wolf" setting

/** The floating chat is just the thread chip, the composer and Dock. Each extra is off; flip one to bring it back (the code is kept). */
/** `ask` (on): a paged `ask` questionnaire shows in the bar as a sheet even while `cards` is off (other cards stay hidden). */
export const BAR_EXTRAS: { cards: boolean; peek: boolean; badge: boolean; switcher: boolean; ask: boolean } = { cards: false, peek: false, badge: false, switcher: false, ask: true };
export const MINIMIZED_KEY = "wolfpack:chatbar:minimized";
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
	/** The wolf's chosen palette key (wolf.yaml `color`); absent = automatic. */
	color?: string;
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

/** Can the bar attach to this thread? Subagent/process threads, children and archived threads cannot. */
export const attachable = (t: BarThread): boolean => (t.kind === "home" || t.kind === "feature") && !t.parentThreadId && !t.closed;

export type ThreadsByWolf = Record<string, readonly BarThread[] | undefined>;

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
