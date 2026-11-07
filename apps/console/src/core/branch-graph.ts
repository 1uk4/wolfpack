/**
 * Git overview model for the header popover: the thread's branch as the main lane with its history grouped by work
 * item, plus one entry per child branch (where it forked, how far ahead/behind). Pure; src/server/branch-graph.ts
 * feeds it from read-only git.
 */
import { WORK_ID_SOURCE } from "./work-id-link.ts";

/** One `git log` row (newest first). */
export interface RawCommit {
	sha: string;
	parents: string[];
	subject: string;
	/** Committer time, unix seconds. */
	time?: number;
}

/** Consecutive main-lane commits that share one work item (`workId` null: no ID in the subject). */
export interface RunNode {
	workId: string | null;
	count: number;
	/** Newest commit's sha and subject (the node's tooltip). */
	sha: string;
	subject: string;
	/** Every sha in the run, so a branch's fork commit can be placed on its node. */
	shas: string[];
}

export interface OverviewBranch {
	name: string;
	kind: "subagent" | "feature";
	ahead: number;
	behind: number;
	/** 0 ahead: everything it did is already on the main lane. */
	landed: boolean;
	/** Index into `history` of the node holding the fork commit; -1 when the fork is older than the window. */
	forkIndex: number;
	/** Main-lane commits hidden between the fork and the window start (only when forkIndex is -1). */
	gap: number;
	/** Committer time (unix s) of the fork commit / of the branch tip; null if unknown. */
	splitAt: number | null;
	lastAt: number | null;
	dirty: boolean;
	/** Full `work-<domain>-<id>` the branch name points at, when its tip's subject confirms the domain. */
	workId: string | null;
}

export interface GitOverview {
	main: { name: string; kind: "wolf" | "feature" };
	/** The main lane's recent history, oldest → newest. */
	history: RunNode[];
	branches: OverviewBranch[];
	/** The main branch against its own parent (feature thread only). */
	parent: { name: string; ahead: number; behind: number } | null;
}

export const EMPTY_OVERVIEW: GitOverview = { main: { name: "", kind: "wolf" }, history: [], branches: [], parent: null };

const WORK_ID_IN_SUBJECT = new RegExp(WORK_ID_SOURCE);

/** The first full `work-<domain>-<id>` in a commit subject, or null. */
export function workIdOfSubject(subject: string): string | null {
	return WORK_ID_IN_SUBJECT.exec(subject)?.[0] ?? null;
}

/** Group a newest-first log into oldest → newest runs of consecutive commits sharing a work ID. */
export function groupRuns(log: RawCommit[]): RunNode[] {
	const runs: RunNode[] = [];
	for (const c of [...log].reverse()) {
		const id = workIdOfSubject(c.subject);
		const last = runs[runs.length - 1];
		if (last && last.workId === id) {
			last.count++;
			last.sha = c.sha;
			last.subject = c.subject;
			last.shas.push(c.sha);
		} else runs.push({ workId: id, count: 1, sha: c.sha, subject: c.subject, shas: [c.sha] });
	}
	return runs;
}

/** `feat/1nLJglH-slug--agent-ab12` → `1nLJglH` (the 7-char id part of a feature branch name), or null. */
export function branchShortId(branch: string): string | null {
	return /^feat\/([0-9A-Za-z]{7})-/.exec(branch)?.[1] ?? null;
}

/** "4d ago" style age of a unix-seconds time. */
export function ageLabel(time: number | null, nowSec: number): string {
	if (time === null) return "?";
	const s = Math.max(0, nowSec - time);
	if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}
