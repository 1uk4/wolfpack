/**
 * Pure view model for the work item page: which wolves to ask, and where the
 * Record comes from (a task's Record usually lives on its parent feature).
 */
import type { WorkRecordResponse } from "./kb.ts";

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
export function featureThreadWolves(wolves: readonly WolfLike[]): string[] {
	const online = wolves.filter((w) => w.status !== "offline");
	return [...online.filter((w) => !w.librarian), ...online.filter((w) => w.librarian)].map((w) => w.name);
}
