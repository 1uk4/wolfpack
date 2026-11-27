/**
 * THE WORK GRAPH'S PROGRESS MODEL (pure, browser-safe): the three stage tones a node is coloured by
 * (plan, in build, shipped), the overall progress bar, and the data of the inline progress panel a click on
 * a node opens. Input is live data only (the item's record, the wolves' thread lists, the work list's
 * assignee); nothing is generated and nothing leaves the machine.
 */

import { threadHref } from "../thread/thread-adapter.ts";
import type { TaskNode, TaskStatus } from "./task-graph.ts";

export type StageTone = "plan" | "build" | "shipped" | "archived";

export const TONE_LABEL: Record<StageTone, string> = { plan: "Plan", build: "In build", shipped: "Shipped", archived: "Archived" };

/** Ready and blocked tasks are still planned work. */
export const toneOfStatus = (s: TaskStatus): StageTone => (s === "building" ? "build" : s === "shipped" ? "shipped" : s === "archived" ? "archived" : "plan");

export interface ProgressBar {
	total: number;
	plan: number;
	build: number;
	shipped: number;
	/** Whole percents of the bar each tone fills (archived children are not counted); they add up to 100, or are all 0 for an empty graph. */
	pct: { plan: number; build: number; shipped: number };
}

export function progressBar(nodes: readonly Pick<TaskNode, "status">[]): ProgressBar {
	const counts = { plan: 0, build: 0, shipped: 0 };
	for (const n of nodes) {
		const t = toneOfStatus(n.status);
		if (t !== "archived") counts[t]++;
	}
	const total = counts.plan + counts.build + counts.shipped;
	if (total === 0) return { total, ...counts, pct: { plan: 0, build: 0, shipped: 0 } };
	const shipped = Math.round((counts.shipped / total) * 100);
	const build = Math.min(100 - shipped, Math.round((counts.build / total) * 100));
	return { total, ...counts, pct: { shipped, build, plan: 100 - shipped - build } };
}

/** What a thread is doing, from the wolf's thread list status. */
export type ThreadLive = "working" | "idle" | "needs-you";

export interface ThreadFact {
	wolf: string;
	id: string;
	/** Wire status of the thread. */
	status?: "idle" | "busy" | "needs-you";
	closed?: boolean;
	/** The work item the thread is bound to. */
	boundItem?: string;
	boundWorkItem?: string;
}

export interface ProgressPanel {
	id: string;
	title: string;
	kind: string;
	tone: StageTone;
	stage: string;
	wolf: string | null;
	thread: { wolf: string; id: string; href: string; live: ThreadLive } | null;
	/** Latest ledger lines that are not commits, newest first (max 3). */
	notes: string[];
	/** Ledger lines that mention a commit hash, newest first (max 3). */
	commits: string[];
	/** The first GitHub pull request URL in the record or ledger; null when none is written down. */
	pr: string | null;
}

const COMMIT = /\bcommit(?:ted)?\b[^\n]*\b[0-9a-f]{7,40}\b/i;
const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

const liveOf = (s: ThreadFact["status"]): ThreadLive => (s === "needs-you" ? "needs-you" : s === "busy" ? "working" : "idle");

/**
 * `item`: the node's own record; `threads`: every wolf's thread rows; `assignee`: the work list's wolf for it.
 * The thread is the open one bound to the item; a needs-you thread wins over a busy one, which wins over an idle one.
 */
export function progressPanel(
	item: { id: string; title: string; kind: string; stage: string; record?: string; log?: readonly string[] },
	status: TaskStatus,
	threads: readonly ThreadFact[],
	assignee?: string,
): ProgressPanel {
	const rank = { "needs-you": 0, working: 1, idle: 2 } as const;
	const mine = threads
		.filter((t) => !t.closed && (t.boundItem ?? t.boundWorkItem) === item.id)
		.map((t) => ({ t, live: liveOf(t.status) }))
		.sort((a, b) => rank[a.live] - rank[b.live]);
	const best = mine[0];
	const newest = [...(item.log ?? [])].reverse();
	const commits = newest.filter((l) => COMMIT.test(l)).slice(0, 3);
	const notes = newest.filter((l) => !COMMIT.test(l)).slice(0, 3);
	const pr = PR_URL.exec(`${item.record ?? ""}\n${newest.join("\n")}`)?.[0] ?? null;
	return {
		id: item.id,
		title: item.title,
		kind: item.kind,
		tone: toneOfStatus(status),
		stage: item.stage,
		wolf: assignee ?? best?.t.wolf ?? null,
		thread: best ? { wolf: best.t.wolf, id: best.t.id, href: threadHref(best.t.wolf, best.t.id), live: best.live } : null,
		notes,
		commits,
		pr,
	};
}
