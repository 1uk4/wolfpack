/**
 * THE DEWEY PIPELINE MODEL (pure): normalised receipt outcomes, inbox lanes,
 * the sweep summary and the live fold of sweep_* memory events over a
 * KbPipelineResponse. Browser-safe; no I/O.
 */

import type { KbPipelineResponse, PipelineLane, PipelineLastSweep, PipelineParked, PipelineReceipt } from "@wolfpack/client";
import type { MemoryEventFrame } from "./kb.ts";

export type { KbPipelineResponse, PipelineLane, PipelineLastSweep, PipelineParked, PipelineReceipt };

export type NormalOutcome = "create" | "merge" | "reject" | "parked" | "unclassified";

/** Receipts spell outcomes both ways (create/created, merge/merged/updated, reject/rejected). */
export function normalizeOutcome(raw: string | null | undefined): NormalOutcome {
	switch ((raw ?? "").trim().toLowerCase()) {
		case "create":
		case "created":
			return "create";
		case "merge":
		case "merged":
		case "updated":
			return "merge";
		case "reject":
		case "rejected":
			return "reject";
		case "parked":
		case "park":
			return "parked";
		default:
			return "unclassified";
	}
}

export const OUTCOME_LABEL: Record<NormalOutcome, string> = {
	create: "created",
	merge: "merged",
	reject: "rejected",
	parked: "parked",
	unclassified: "unclassified",
};

/** Outcomes whose receipt line explains a decision worth showing. */
export function showsDetail(outcome: NormalOutcome): boolean {
	return outcome === "reject" || outcome === "parked";
}

/** The live view state: the fetched response plus the sweep in flight (from sweep_started). */
export interface PipelineState {
	data: KbPipelineResponse;
	/** Set by sweep_started, cleared by sweep_finished. */
	running: { startedAt: string; pending: number } | null;
}

export const RECEIPT_CAP = 50;

export function initialState(data: KbPipelineResponse): PipelineState {
	return { data, running: data.sweep.current ? { startedAt: data.sweep.current.startedAt, pending: 0 } : null };
}

/** Lanes with work first (oldest wait first), then empty lanes by name. */
export function lanes(data: KbPipelineResponse): PipelineLane[] {
	return [...data.lanes].sort((a, b) => {
		if ((a.pending > 0) !== (b.pending > 0)) return a.pending > 0 ? -1 : 1;
		if (a.pending > 0 && b.pending > 0 && (a.oldestAgeMs ?? 0) !== (b.oldestAgeMs ?? 0)) return (b.oldestAgeMs ?? 0) - (a.oldestAgeMs ?? 0);
		return a.wolf.localeCompare(b.wolf);
	});
}

export function totalPending(data: KbPipelineResponse): number {
	return data.lanes.reduce((n, l) => n + l.pending, 0);
}

export type SweepSummary =
	| { kind: "running"; current?: { from: string; denTopicId: string; startedAt: string }; pending?: number }
	| { kind: "finished"; last: PipelineLastSweep; ok: boolean }
	| { kind: "never" };

/** Current sweep wins; else the last finished one (ok = no error); else never. */
export function sweepSummary(state: PipelineState): SweepSummary {
	const { data, running } = state;
	if (running || data.sweep.current) {
		const out: SweepSummary = { kind: "running" };
		if (data.sweep.current) out.current = data.sweep.current;
		if (running && running.pending > 0) out.pending = running.pending;
		return out;
	}
	const last = data.sweep.last;
	return last ? { kind: "finished", last, ok: !last.error } : { kind: "never" };
}

/** "3m ago" / "just now"; `now` injectable for tests. */
export function relativeTime(iso: string, now: number = Date.now()): string {
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return iso;
	return `${formatAge(Math.max(0, now - t))} ago`.replace(/^just now ago$/, "just now");
}

export function formatAge(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 10) return "just now";
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h`;
	return `${Math.floor(h / 24)}d`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = ms / 1000;
	return s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Fold a sweep_* event over the state. Other events return the state
 * unchanged (same reference). sweep_finished does not synthesise `last`
 * counts into lanes: the caller refetches for truth, but the summary is
 * updated immediately so there is no flicker.
 */
export function applySweepEvent(state: PipelineState, e: MemoryEventFrame): PipelineState {
	const at = typeof e.timestamp === "string" ? e.timestamp : new Date().toISOString();
	switch (e.type) {
		case "sweep_started": {
			const { current: _drop, ...sweep } = state.data.sweep;
			return { data: { ...state.data, sweep }, running: { startedAt: at, pending: isNum(e.pending) ? e.pending : 0 } };
		}
		case "sweep_item": {
			if (typeof e.from !== "string" || typeof e.denTopicId !== "string") return state;
			const outcome = normalizeOutcome(typeof e.outcome === "string" ? e.outcome : null);
			const receipt: PipelineReceipt = { wolf: e.from, denTopicId: e.denTopicId, outcome, processed: at };
			if (typeof e.entryId === "string") receipt.entryId = e.entryId;
			const lanesNext = state.data.lanes.map((l) => {
				if (l.wolf !== e.from) return l;
				const pending = Math.max(0, l.pending - 1);
				if (pending > 0) return { ...l, pending };
				const { oldestAgeMs: _o, ...rest } = l;
				return { ...rest, pending };
			});
			const data: KbPipelineResponse = {
				...state.data,
				lanes: lanesNext,
				receipts: [receipt, ...state.data.receipts].slice(0, RECEIPT_CAP),
			};
			if (outcome === "parked") data.parkedTotal = (state.data.parkedTotal ?? state.data.parked.length) + 1;
			return { data, running: state.running ?? { startedAt: at, pending: 0 } };
		}
		case "sweep_finished": {
			const startedAt = state.running?.startedAt ?? at;
			const last: PipelineLastSweep = {
				startedAt,
				finishedAt: at,
				processed: isNum(e.processed) ? e.processed : 0,
				created: isNum(e.created) ? e.created : 0,
				merged: isNum(e.merged) ? e.merged : 0,
				rejected: isNum(e.rejected) ? e.rejected : 0,
				parked: isNum(e.parked) ? e.parked : 0,
				remaining: isNum(e.remaining) ? e.remaining : 0,
				durationMs: isNum(e.durationMs) ? e.durationMs : 0,
			};
			if (typeof e.error === "string" && e.error) last.error = e.error;
			return { data: { ...state.data, sweep: { last } }, running: null };
		}
		default:
			return state;
	}
}
