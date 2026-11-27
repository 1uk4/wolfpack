/**
 * THE DEN STRIP (work-wolfpack-XR2Jmxf): the row of wolf buttons above the chat bar. PURE: no React, no IO.
 * One item per wolf: its colour, whether it is working, how many cards wait on the owner, and the rows of its needs-you sheet.
 * The count is the cards when they are loaded, else the threads the lists say are waiting (the cards load when the sheet opens).
 * There is no per-wolf working status in the data (WolfLite.status is online/offline), so a wolf is working when any of its threads is busy.
 */
import { attachable, type ThreadsByWolf, type WolfLite } from "./chat-bar.ts";
import { cardHeadline, type NeedsYouItem } from "./needs-you.ts";
import { threadColor } from "./thread-color.ts";

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
	working: boolean;
	needsYou: number;
	rows: DenRow[];
}

/**
 * The strip's items in wolf order. An offline wolf and the librarian are left out unless a card is waiting on them
 * (the owner can still answer it); a wolf with waiting cards is listed even when its thread list has not loaded.
 */
export function buildDenStrip(wolves: readonly WolfLite[], threads: ThreadsByWolf, needs: readonly NeedsYouItem[]): DenStripItem[] {
	const out: DenStripItem[] = [];
	for (const w of wolves) {
		const mine = needs.filter((n) => n.wolf === w.name);
		if ((w.status === "offline" || w.librarian) && mine.length === 0) continue;
		const list = threads[w.name] ?? [];
		const home = list.find((t) => t.kind === "home");
		out.push({
			wolf: w.name,
			color: threadColor({ id: home?.id ?? `${w.name}/home`, kind: "home" }, [], w.color).hex,
			working: list.some((t) => t.status === "busy"),
			needsYou: Math.max(mine.length, list.filter((t) => t.status === "needs-you" && attachable(t)).length),
			rows: mine.map((n) => ({ wolf: n.wolf, threadId: n.threadId, callId: n.callId, title: n.threadTitle, summary: cardHeadline(n.card), href: n.href })),
		});
	}
	return out;
}

/** The button's accessible name: "<wolf>, working, N needs you" with the parts that apply. */
export function denLabel(i: Pick<DenStripItem, "wolf" | "working" | "needsYou">): string {
	return [i.wolf, ...(i.working ? ["working"] : []), ...(i.needsYou > 0 ? [`${i.needsYou} ${i.needsYou === 1 ? "needs" : "need"} you`] : [])].join(", ");
}
