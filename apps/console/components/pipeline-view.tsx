"use client";

/**
 * The Dewey pipeline page body (/pipeline): inbox lanes per wolf, the
 * current/last sweep, recent receipts and parked items. Live: sweep_* memory
 * events fold into the state; sweep_finished and a resync refetch for truth.
 */
import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
	OUTCOME_LABEL,
	applySweepEvent,
	entryHref,
	formatAge,
	formatDuration,
	initialState,
	lanes,
	normalizeOutcome,
	relativeTime,
	showsDetail,
	sweepSummary,
	totalPending,
	type KbPipelineResponse,
	type PipelineState,
	type SweepSummary,
} from "@/src/core";
import { fetchKbPipeline } from "./pipeline-client";
import { useMemoryEvents } from "./memory-events";
import { useLibrarian } from "./use-librarian";

const absolute = (iso: string): string => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

function Section({ title, aside, children }: { title: string; aside?: string; children: React.ReactNode }) {
	return (
		<section className="mb-8">
			<h2 className="mb-2 flex items-baseline gap-2 font-ui text-[11px] uppercase tracking-wide text-muted-foreground">
				{title}
				{aside ? <span className="normal-case tracking-normal text-muted-foreground/60">{aside}</span> : null}
			</h2>
			{children}
		</section>
	);
}

export function PipelineUnavailable({ message }: { message: string }) {
	return (
		<div className="p-6 font-ui text-sm text-muted-foreground" data-testid="pipeline-unavailable">
			<p>The pipeline is unavailable.</p>
			<p className="mt-1 text-[12px] text-muted-foreground/70">{message}</p>
		</div>
	);
}

function SweepCard({ summary, now }: { summary: SweepSummary; now: number }) {
	if (summary.kind === "never") return <p className="text-sm text-muted-foreground" data-testid="sweep-never">No sweep has run yet.</p>;
	if (summary.kind === "running") {
		return (
			<div className="text-sm" data-testid="sweep-running">
				<span className="text-foreground">Sweeping</span>
				{summary.current ? (
					<span className="text-muted-foreground">
						{" "}
						{summary.current.from} / {summary.current.denTopicId}
					</span>
				) : null}
				{summary.pending ? <span className="text-muted-foreground"> · {summary.pending} pending</span> : null}
			</div>
		);
	}
	const { last } = summary;
	return (
		<div className="text-sm" data-testid="sweep-last">
			<div>
				<span className="text-foreground">Last run</span>{" "}
				<span title={absolute(last.finishedAt)} className="text-muted-foreground">
					{relativeTime(last.finishedAt, now)} · {absolute(last.finishedAt)}
				</span>
			</div>
			<div className="mt-1 text-muted-foreground">
				{last.processed} processed · {last.created} created · {last.merged} merged · {last.rejected} rejected · {last.parked} parked ·{" "}
				{last.remaining} remaining · {formatDuration(last.durationMs)}
			</div>
			{last.error ? (
				<div className="mt-1 text-destructive" data-testid="sweep-error">
					{last.error}
				</div>
			) : null}
		</div>
	);
}

/** The pure body (SSR-pinnable). */
export function PipelineBody({ state, now }: { state: PipelineState; now: number }) {
	const { data } = state;
	const parkedTotal = data.parkedTotal ?? data.parked.length;
	return (
		<div className="mx-auto max-w-3xl p-6 font-ui" data-testid="pipeline-view">
			<h1 className="mb-6 text-base text-foreground">Pipeline</h1>

			<Section title="Inbox" aside={`${totalPending(data)} pending`}>
				{data.lanes.length === 0 ? (
					<p className="text-sm text-muted-foreground">No inbox lanes.</p>
				) : (
					<ul className="space-y-1" data-testid="pipeline-lanes">
						{lanes(data).map((l) => (
							<li key={l.wolf} className="flex items-baseline gap-3 text-sm" data-lane={l.wolf}>
								<span className="w-32 truncate text-foreground">{l.wolf}</span>
								<span className="text-muted-foreground">{l.pending} pending</span>
								{l.pending > 0 && l.oldestAgeMs !== undefined ? (
									<span className="text-muted-foreground/60">oldest {formatAge(l.oldestAgeMs)}</span>
								) : null}
							</li>
						))}
					</ul>
				)}
			</Section>

			<Section title="Sweep">
				<SweepCard summary={sweepSummary(state)} now={now} />
			</Section>

			<Section title="Recent" aside={`${data.receipts.length}`}>
				{data.receipts.length === 0 ? (
					<p className="text-sm text-muted-foreground">Nothing processed yet.</p>
				) : (
					<ul className="space-y-1.5" data-testid="pipeline-receipts">
						{data.receipts.map((r, i) => {
							const outcome = normalizeOutcome(r.outcome);
							return (
								<li key={`${r.wolf}/${r.denTopicId}/${r.processed}/${i}`} className="text-sm" data-outcome={outcome}>
									<div className="flex items-baseline gap-3">
										<span className="w-20 shrink-0 text-muted-foreground">{OUTCOME_LABEL[outcome]}</span>
										<span className="truncate text-foreground">
											{r.wolf} / {r.denTopicId}
										</span>
										{r.entryId ? (
											<Link href={entryHref(r.entryId)} className="truncate text-muted-foreground underline underline-offset-2 hover:text-foreground">
												{r.entryId}
											</Link>
										) : null}
										<span className="ml-auto shrink-0 text-muted-foreground/60" title={absolute(r.processed)}>
											{relativeTime(r.processed, now)}
										</span>
									</div>
									{showsDetail(outcome) && r.detail ? <div className="ml-[92px] text-[12px] text-muted-foreground/70">{r.detail}</div> : null}
								</li>
							);
						})}
					</ul>
				)}
			</Section>

			<Section title="Parked" aside={`${parkedTotal} total`}>
				{data.parked.length === 0 ? (
					<p className="text-sm text-muted-foreground">Nothing parked.</p>
				) : (
					<ul className="space-y-1.5" data-testid="pipeline-parked">
						{data.parked.map((p) => (
							<li key={`${p.wolf}/${p.file}`} className="text-sm">
								<span className="text-foreground">
									{p.wolf} / {p.denTopicId ?? p.file}
								</span>
								{p.reason ? <div className="text-[12px] text-muted-foreground/70">{p.reason}</div> : null}
							</li>
						))}
						{parkedTotal > data.parked.length ? (
							<li className="text-[12px] text-muted-foreground/60">and {parkedTotal - data.parked.length} more</li>
						) : null}
					</ul>
				)}
			</Section>
		</div>
	);
}

type Load = { kind: "loading" } | { kind: "unavailable"; message: string } | { kind: "ready" };

export function PipelineView() {
	const { librarian, loading } = useLibrarian();
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const [state, dispatch] = useReducer(
		(s: PipelineState | null, a: { type: "set"; data: KbPipelineResponse } | { type: "event"; e: Parameters<typeof applySweepEvent>[1] }) =>
			a.type === "set" ? initialState(a.data) : s ? applySweepEvent(s, a.e) : s,
		null,
	);
	const [now, setNow] = useState(() => Date.now());
	const seq = useRef(0);

	const refetch = useCallback(() => {
		if (!librarian) return;
		const mine = ++seq.current;
		void fetchKbPipeline(librarian).then((res) => {
			if (mine !== seq.current) return;
			if (res.ok) {
				dispatch({ type: "set", data: res.data });
				setLoad({ kind: "ready" });
			} else setLoad((prev) => (res.reason === "unavailable" || prev.kind !== "ready" ? { kind: "unavailable", message: res.message } : prev));
		});
	}, [librarian]);

	useEffect(() => {
		refetch();
	}, [refetch]);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(id);
	}, []);

	useMemoryEvents(
		librarian,
		(e) => {
			if (!e.type.startsWith("sweep_")) return;
			dispatch({ type: "event", e });
			if (e.type === "sweep_finished") refetch();
		},
		refetch,
	);

	if (loading) return <div className="p-6 text-sm text-muted-foreground" data-testid="pipeline-view">Loading…</div>;
	if (!librarian) return <PipelineUnavailable message="No librarian wolf is configured." />;
	if (load.kind === "unavailable") return <PipelineUnavailable message={load.message} />;
	if (load.kind === "loading" || !state) return <div className="p-6 text-sm text-muted-foreground" data-testid="pipeline-view">Loading…</div>;
	return <PipelineBody state={state} now={now} />;
}

