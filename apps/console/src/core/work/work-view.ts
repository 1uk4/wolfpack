/**
 * Pure view model for the work item page: which wolves to ask, and where the
 * Record comes from (a task's Record usually lives on its parent feature).
 */
import type { WorkRecordResponse } from "../kb/kb.ts";

export interface WolfLike {
	name: string;
	status: string;
	librarian?: boolean;
}

/** Wolves to try for a work record, in order: the librarian, then every other reachable wolf (online or busy:
 *  a wolf mid-turn still serves its Work API; only "offline" is skipped). */
export function workWolfCandidates(librarian: string | null, wolves: readonly WolfLike[]): string[] {
	const out: string[] = [];
	if (librarian) out.push(librarian);
	for (const w of wolves) if (w.status !== "offline" && !out.includes(w.name)) out.push(w.name);
	return out;
}

export interface WorkRecordView {
	/** Markdown to show under "Record"; "" when there is none anywhere. */
	markdown: string;
	/** Set when the markdown came from the parent feature. */
	fromParent: { id: string; title: string } | null;
}

/** The own Record when non-empty, else the parent's (when fetched), else empty. */
export function workRecordView(
	record: Pick<WorkRecordResponse, "record">,
	parent: Pick<WorkRecordResponse, "id" | "title" | "record"> | null,
): WorkRecordView {
	if (record.record.trim()) return { markdown: record.record, fromParent: null };
	if (parent?.record.trim()) return { markdown: parent.record, fromParent: { id: parent.id, title: parent.title } };
	return { markdown: "", fromParent: null };
}

export type WorkLookup =
	| { ok: true; data: WorkRecordResponse }
	| { ok: false; reason: "unavailable" | "not_found" | "error"; message: string };

export type WorkResolution =
	| { kind: "none" }
	| { kind: "hit"; wolf: string; result: WorkLookup };

/**
 * Ask each candidate in order. Only "unavailable" moves on to the next wolf;
 * a hit, a 404 or any other error is final. No candidate answering → "none".
 */
export async function resolveWork(
	candidates: readonly string[],
	id: string,
	fetchRecord: (wolf: string, id: string) => Promise<WorkLookup>,
): Promise<WorkResolution> {
	for (const wolf of candidates) {
		const result = await fetchRecord(wolf, id);
		if (result.ok || result.reason !== "unavailable") return { kind: "hit", wolf, result };
	}
	return { kind: "none" };
}

/**
 * Wolves a feature thread can be opened on: every online wolf, the first non-librarian first (the librarian serves
 * the KB; coding work goes to the others). Empty when none is online.
 */
export interface ThreadRow {
	id: string;
	kind?: string;
	boundItem?: string;
	boundWorkItem?: string;
	closed?: boolean;
	closedReason?: string;
}

export interface FeatureThreadButton {
	wolf: string;
	/** none: create one; open: go to it; closed: reopen it (the owner closed it). */
	state: "none" | "open" | "closed";
	threadId?: string;
}

/**
 * One button per wolf for a feature's thread: create (none), go to (open) or reopen (closed by the owner). A thread closed by
 * graduation cannot be reopened, so it counts as open (navigate to read it). Wolves holding a live thread come first.
 */
export function featureThreadButtons(featureId: string, wolves: readonly string[], threads: Readonly<Record<string, readonly ThreadRow[]>>): FeatureThreadButton[] {
	const rows = wolves.map((wolf): FeatureThreadButton => {
		const list = threads[wolf] ?? [];
		const hit = list.find((t) => t.kind === "feature" && (t.boundItem ?? t.boundWorkItem) === featureId);
		if (!hit) return { wolf, state: "none" };
		const ownerClosed = hit.closed === true && hit.closedReason === "Closed by you";
		return { wolf, state: ownerClosed ? "closed" : "open", threadId: hit.id };
	});
	const rank = (b: FeatureThreadButton) => (b.state === "open" ? 0 : 1);
	return rows.map((b, i) => ({ b, i })).sort((x, y) => rank(x.b) - rank(y.b) || x.i - y.i).map((x) => x.b);
}

export function threadButtonLabel(b: FeatureThreadButton, several: boolean): string {
	const verb = b.state === "open" ? "Go to thread" : b.state === "closed" ? "Reopen thread" : "Open thread";
	return several ? `${verb} on ${b.wolf}` : verb;
}

export function featureThreadWolves(wolves: readonly WolfLike[]): string[] {
	const online = wolves.filter((w) => w.status !== "offline");
	return [...online.filter((w) => !w.librarian), ...online.filter((w) => w.librarian)].map((w) => w.name);
}
