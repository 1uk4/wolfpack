/**
 * THE DEN STRIP (work-wolfpack-XR2Jmxf): the row of wolf buttons above the chat bar. PURE: no React, no IO.
 * One item per wolf: its colour, whether it is working, how many cards wait on the owner, and the rows of its needs-you sheet.
 * The count is the cards when they are loaded, else the threads the lists say are waiting (the cards load when the sheet opens).
 * `swapWolf` (the attached wolf, only while a swap is on offer) marks that wolf's item `swap`.
 * There is no per-wolf working status in the data (WolfLite.status is online/offline), so a wolf is working when any of its threads is busy.
 */
import { attachable, type SwitcherEntry, type SwitcherGroup, type ThreadsByWolf, type WolfLite } from "./chat-bar.ts";
import { threadSlug } from "./thread-adapter.ts";
import { cardHeadline, type NeedsYouItem } from "./needs-you.ts";
import { THREAD_COLORS, type ThreadColor } from "@wolfpack/protocol";
import { effectiveWolfColor } from "./wolf-color.ts";

/** One line of a wolf's sheet: the thread it is raised in and the card's headline. `href` opens the thread; `threadId` + `callId` name the card. */
export interface DenRow {
	wolf: string;
	threadId: string;
	callId: string;
	title: string;
	summary: string;
	href: string;
}

export interface DenStripItem {
	wolf: string;
	/** The wolf's colour (hex): its chosen palette colour, else its home thread's automatic one. */
	color: string;
	/** The wolf's colour key (effectiveWolfColor): what theme-aware surfaces pass to wolfColorStyle. */
	colorKey: ThreadColor;
	working: boolean;
	needsYou: number;
	rows: DenRow[];
	/** The wolf's home thread (the sheet's "Move chat to" target); undefined when its list has none. */
	homeThreadId?: string;
	/** The chat is attached to this wolf and floats over another thread's page: the button is the swap control, not the wolf mark. */
	swap: boolean;
}

/**
 * The strip's items in wolf order. An offline wolf and the librarian are left out unless a card is waiting on them
 * (the owner can still answer it); a wolf with waiting cards is listed even when its thread list has not loaded.
 */
export function buildDenStrip(wolves: readonly WolfLite[], threads: ThreadsByWolf, needs: readonly NeedsYouItem[], swapWolf?: string | null, alsoShow?: string | null): DenStripItem[] {
	const out: DenStripItem[] = [];
	for (const w of wolves) {
		const mine = needs.filter((n) => n.wolf === w.name);
		if ((w.status === "offline" || w.librarian) && mine.length === 0 && swapWolf !== w.name && alsoShow !== w.name) continue; // the swap wolf and the attached wolf always keep a button
		const list = threads[w.name] ?? [];
		const home = list.find((t) => t.kind === "home");
		const colorKey = effectiveWolfColor(w, home?.id);
		out.push({
			wolf: w.name,
			color: THREAD_COLORS[colorKey],
			colorKey,
			homeThreadId: home?.id,
			swap: swapWolf === w.name,
			working: list.some((t) => t.status === "busy"),
			needsYou: Math.max(mine.length, list.filter((t) => t.status === "needs-you" && attachable(t)).length),
			rows: mine.map((n) => ({ wolf: n.wolf, threadId: n.threadId, callId: n.callId, title: n.threadTitle, summary: cardHeadline(n.card), href: n.href })),
		});
	}
	return out;
}

/** One thread of the wolf's sheet: the switcher entry, whether the chat is attached to it, and the cards waiting in it. */
export interface DenSheetThread extends Omit<SwitcherEntry, "needsYou"> {
	current: boolean;
	/** Cards waiting in this thread (at least 1 when the list says it waits and the cards have not loaded yet). */
	needsYou: number;
	rows: DenRow[];
}

/** The combined sheet (work-wolfpack-ftBY9Qv): the old thread switcher, the needs-you rows and the swap state for one wolf. */
export interface DenSheet {
	wolf: string;
	color: string;
	online: boolean;
	needsYou: number;
	swap: boolean;
	threads: DenSheetThread[];
	/** Cards on threads that are not in the list (sub-threads, closed ones): still reachable, they open their thread. */
	other: DenRow[];
}

/**
 * One wolf's sheet from its strip item, its buildSwitcher group and the attached thread. The home thread leads, then the
 * feature threads in buildSwitcher's order (waiting ones first, then the recent ones). buildSwitcher lists no sub-threads
 * (they are not attachable), so none are nested.
 */
export function buildDenSheet(item: DenStripItem, group: SwitcherGroup | undefined, current: { wolf: string; threadId: string } | null): DenSheet {
	const entries = group?.entries ?? [];
	const ordered = [...entries.filter((e) => e.kind === "home"), ...entries.filter((e) => e.kind !== "home")];
	const slugOf = (id: string) => threadSlug(item.wolf, id);
	const known = new Set(entries.map((e) => slugOf(e.threadId)));
	const threads = ordered.map((e) => {
		const rows = item.rows.filter((r) => slugOf(r.threadId) === slugOf(e.threadId));
		return { ...e, current: !!current && current.wolf === e.wolf && slugOf(current.threadId) === slugOf(e.threadId), needsYou: Math.max(rows.length, e.needsYou ? 1 : 0), rows };
	});
	return {
		wolf: item.wolf,
		color: item.color,
		online: (group?.status ?? "offline") !== "offline",
		needsYou: item.needsYou,
		swap: item.swap,
		threads,
		other: item.rows.filter((r) => !known.has(slugOf(r.threadId))),
	};
}

/** The button's accessible name: "<wolf>, working, N needs you" with the parts that apply. */
export function denLabel(i: Pick<DenStripItem, "wolf" | "working" | "needsYou">): string {
	return [i.wolf, ...(i.working ? ["working"] : []), ...(i.needsYou > 0 ? [`${i.needsYou} ${i.needsYou === 1 ? "needs" : "need"} you`] : [])].join(", ");
}
