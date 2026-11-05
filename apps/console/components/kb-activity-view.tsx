"use client";

/**
 * The KB activity page body (/kb-activity), served by the hub's own ledger: waiting contributions per wolf, every contribution's
 * decision (outcome, target entry, why, routing detail) and the latest changes per domain. Live: the app-wide event stream carries the
 * curator's sweep_* frames (hub-event); sweep_item folds in optimistically, sweep_finished / kb.changed / resync refetch (debounced, with
 * a request sequence so a stale answer never lands), and a 60 s poll is the fallback.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	KB_ACTIVITY_PAGE,
	KB_ACTIVITY_SINCE,
	PROVISIONAL_PREFIX,
	applyHubEvent,
	changeColumns,
	curatorNote,
	decisionRows,
	entryHref,
	filterDecisions,
	groupIncoming,
	initialActivityState,
	kbAge,
	kbRelativeTime,
	mergeDecisionPages,
	needsRefetch,
	outcomeFilters,
	routingSummary,
	type DecisionRow,
	type KbActivityResponse,
	type KbActivitySince,
	type KbActivityState,
	type KbDecisionOutcome,
} from "@/src/core";
import { fetchKbActivity } from "./kb-activity-client";
import { useOptionalServerEvent, useOptionalServerResync } from "./server-events";

const absolute = (iso: string): string => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

function Section({ title, aside, children, testId }: { title: string; aside?: string; children: React.ReactNode; testId?: string }) {
	return (
		<section className="mb-8" data-testid={testId}>
			<h2 className="mb-2 flex items-baseline gap-2 font-ui text-[11px] uppercase tracking-wide text-muted-foreground">
				{title}
				{aside ? <span className="normal-case tracking-normal text-muted-foreground/60">{aside}</span> : null}
			</h2>
			{children}
		</section>
	);
}

export function KbActivityUnavailable({ message }: { message: string }) {
	return (
		<div className="p-6 font-ui text-sm text-muted-foreground" data-testid="kb-activity-unavailable">
			<p>KB activity is unavailable.</p>
			<p className="mt-1 text-[12px] text-muted-foreground/70">{message}</p>
		</div>
	);
}

export function IncomingPanel({ data }: { data: KbActivityResponse; now?: number }) {
	const wolves = groupIncoming(data);
	return (
		<Section title="Incoming" aside={`${data.incoming.total} waiting`} testId="kb-incoming">
			{wolves.length === 0 ? (
				<p className="text-sm text-muted-foreground" data-testid="kb-incoming-empty">Nothing is waiting.</p>
			) : (
				<ul className="space-y-2" data-testid="kb-incoming-wolves">
					{wolves.map((w) => (
						<li key={w.wolf} className="text-sm" data-wolf={w.wolf}>
							<div className="flex items-baseline gap-3">
								<span className="w-32 truncate text-foreground">{w.wolf}</span>
								<span className="text-muted-foreground">{w.pending} pending</span>
								{w.pending > 0 && w.oldestAgeMs !== undefined ? <span className="text-muted-foreground/60">oldest {kbAge(w.oldestAgeMs)}</span> : null}
								{w.bad ? <span className="text-destructive">{w.bad} bad</span> : null}
							</div>
							{w.items.length > 0 ? (
								<ul className="ml-[140px] mt-0.5 text-[12px] text-muted-foreground/70">
									{w.items.map((i) => (
										<li key={`${i.denTopicId}/${i.hash ?? ""}`} className="truncate">
											{i.denTopicId} <span className="text-muted-foreground/50">· {kbAge(i.ageMs)}</span>
										</li>
									))}
								</ul>
							) : null}
						</li>
					))}
				</ul>
			)}
		</Section>
	);
}

function DecisionItem({ row, now }: { row: DecisionRow; now: number }) {
	const lines = routingSummary(row.routing);
	return (
		<li className="text-sm" data-outcome={row.outcome} data-decision={row.id} data-provisional={row.provisional ? "true" : undefined}>
			<div className="flex items-baseline gap-3">
				<span className="w-24 shrink-0 text-muted-foreground" data-testid="kb-outcome-chip">{row.label}</span>
				<span className="truncate text-foreground">
					{row.wolf} / {row.denTopicId}
				</span>
				{row.entryId ? (
					<Link href={entryHref(row.entryId)} className="truncate text-muted-foreground underline underline-offset-2 hover:text-foreground">
						{row.entryId}
					</Link>
				) : null}
				{row.superseded > 0 ? <span className="shrink-0 text-[11px] text-muted-foreground/50">replaced {row.superseded}</span> : null}
				<span className="ml-auto shrink-0 text-muted-foreground/60" title={absolute(row.at)}>
					{kbRelativeTime(row.at, now)}
				</span>
			</div>
			{row.reason ? <div className="ml-[108px] text-[12px] text-muted-foreground/70">{row.reason}</div> : null}
			{lines.length > 0 ? (
				<details className="ml-[108px] text-[12px] text-muted-foreground/70">
					<summary className="cursor-pointer select-none text-muted-foreground/50">routing</summary>
					<ul data-testid="kb-routing">
						{lines.map((l) => (
							<li key={l}>{l}</li>
						))}
					</ul>
				</details>
			) : null}
		</li>
	);
}

export function DecisionFeed({
	data,
	now,
	outcome,
	since,
	loadingMore,
	onOutcome,
	onSince,
	onLoadMore,
}: {
	data: KbActivityResponse;
	now: number;
	outcome: KbDecisionOutcome | "all";
	since: KbActivitySince;
	loadingMore?: boolean;
	onOutcome?: (o: KbDecisionOutcome | "all") => void;
	onSince?: (s: KbActivitySince) => void;
	onLoadMore?: () => void;
}) {
	const rows = filterDecisions(decisionRows(data.decisions.items), outcome);
	const note = curatorNote(data);
	const chip = (active: boolean) =>
		`rounded border px-1.5 py-0.5 text-[11px] ${active ? "border-foreground/40 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;
	return (
		<Section title="Decisions" aside={`${data.decisions.total} in range`} testId="kb-decisions">
			{note ? (
				<p className="mb-2 text-sm text-muted-foreground" data-testid="kb-curator-note">{note}</p>
			) : null}
			<div className="mb-3 flex flex-wrap items-center gap-1.5" data-testid="kb-decision-filters">
				{outcomeFilters(data).map((f) => (
					<button key={f.key} type="button" className={chip(outcome === f.key)} aria-pressed={outcome === f.key} data-filter={f.key} onClick={() => onOutcome?.(f.key)}>
						{f.label} {f.count}
					</button>
				))}
				<span className="ml-auto flex gap-1" data-testid="kb-since">
					{KB_ACTIVITY_SINCE.map((s) => (
						<button key={s} type="button" className={chip(since === s)} aria-pressed={since === s} data-since={s} onClick={() => onSince?.(s)}>
							{s}
						</button>
					))}
				</span>
			</div>
			{rows.length === 0 ? (
				<p className="text-sm text-muted-foreground" data-testid="kb-decisions-empty">{data.decisions.items.length === 0 ? "No decisions in this range." : "No decisions match this filter."}</p>
			) : (
				<ul className="space-y-2" data-testid="kb-decision-list">
					{rows.map((r) => (
						<DecisionItem key={r.id} row={r} now={now} />
					))}
				</ul>
			)}
			{data.decisions.nextCursor ? (
				<button type="button" className="mt-3 rounded border border-border px-2 py-1 text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={loadingMore} onClick={() => onLoadMore?.()} data-testid="kb-load-more">
					{loadingMore ? "Loading…" : "Load more"}
				</button>
			) : null}
		</Section>
	);
}

export function ChangesPanel({ data, now }: { data: KbActivityResponse; now: number }) {
	const columns = changeColumns(data);
	return (
		<Section title="Recent changes" testId="kb-changes">
			{columns.length === 0 ? (
				<p className="text-sm text-muted-foreground" data-testid="kb-changes-empty">No changes yet.</p>
			) : (
				<div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(columns.length, 3)}, minmax(0, 1fr))` }} data-testid="kb-change-columns">
					{columns.map((c) => (
						<div key={c.domain} data-domain={c.domain}>
							<h3 className="mb-1 text-[12px] text-foreground">{c.domain}</h3>
							{c.rows.length === 0 ? (
								<p className="text-[12px] text-muted-foreground/60">Nothing yet.</p>
							) : (
								<ul className="space-y-1">
									{c.rows.map((r) => (
										<li key={r.key} className="text-[12px]" data-action={r.action}>
											<span className="text-muted-foreground">{r.label}</span>{" "}
											<Link href={entryHref(r.entryId)} className="text-foreground underline underline-offset-2">
												{r.title}
											</Link>
											<div className="text-muted-foreground/60" title={absolute(r.at)}>
												{r.wolf ? `${r.wolf} · ` : ""}
												{kbRelativeTime(r.at, now)}
											</div>
										</li>
									))}
								</ul>
							)}
						</div>
					))}
				</div>
			)}
		</Section>
	);
}

/** The pure body (SSR-pinnable). */
export function KbActivityBody({
	state,
	now,
	outcome = "all",
	since = "30d",
	loadingMore,
	onOutcome,
	onSince,
	onLoadMore,
}: {
	state: KbActivityState;
	now: number;
	outcome?: KbDecisionOutcome | "all";
	since?: KbActivitySince;
	loadingMore?: boolean;
	onOutcome?: (o: KbDecisionOutcome | "all") => void;
	onSince?: (s: KbActivitySince) => void;
	onLoadMore?: () => void;
}) {
	const { data } = state;
	return (
		<div className="mx-auto max-w-4xl p-6 font-ui" data-testid="kb-activity-view">
			<h1 className="mb-6 flex items-baseline gap-3 text-base text-foreground">
				KB activity
				{state.sweeping ? <span className="text-[12px] text-muted-foreground" data-testid="kb-sweeping">sweeping…</span> : null}
			</h1>
			<IncomingPanel data={data} now={now} />
			<DecisionFeed data={data} now={now} outcome={outcome} since={since} {...(loadingMore !== undefined ? { loadingMore } : {})} {...(onOutcome ? { onOutcome } : {})} {...(onSince ? { onSince } : {})} {...(onLoadMore ? { onLoadMore } : {})} />
			<ChangesPanel data={data} now={now} />
		</div>
	);
}

type Load = { kind: "loading" } | { kind: "unavailable"; message: string } | { kind: "ready" };

const DEBOUNCE_MS = 500;
const POLL_MS = 60_000;

export function KbActivityView() {
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const [state, setState] = useState<KbActivityState | null>(null);
	const [since, setSince] = useState<KbActivitySince>("30d");
	const [outcome, setOutcome] = useState<KbDecisionOutcome | "all">("all");
	const [loadingMore, setLoadingMore] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const seq = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const loaded = useRef(0);
	loaded.current = state ? state.data.decisions.items.filter((d) => !d.id.startsWith(PROVISIONAL_PREFIX)).length : 0;

	/** Fetch the first page(s) and REPLACE the data (provisional rows go with it). Keeps as many rows as were already loaded. */
	const refetch = useCallback(() => {
		const mine = ++seq.current;
		const limit = Math.min(200, Math.max(KB_ACTIVITY_PAGE, loaded.current));
		void fetchKbActivity({ since, limit }).then((res) => {
			if (mine !== seq.current) return; // a newer request owns the screen
			if (res.ok) {
				setState(initialActivityState(res.data));
				setLoad({ kind: "ready" });
			} else setLoad((prev) => (res.reason === "unavailable" || prev.kind !== "ready" ? { kind: "unavailable", message: res.message } : prev));
		});
	}, [since]);

	const refetchSoon = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			timer.current = null;
			refetch();
		}, DEBOUNCE_MS);
	}, [refetch]);

	useEffect(() => {
		setLoad({ kind: "loading" });
		setState(null);
		loaded.current = 0;
		refetch();
		return () => {
			seq.current++;
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
		};
	}, [refetch]);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 30_000);
		const poll = setInterval(refetch, POLL_MS);
		return () => {
			clearInterval(id);
			clearInterval(poll);
		};
	}, [refetch]);

	useOptionalServerEvent("hub-event", ({ frame }) => {
		setState((s) => (s ? applyHubEvent(s, frame) : s));
		if (needsRefetch(frame)) refetchSoon();
	});
	useOptionalServerResync(refetchSoon);

	const loadMore = useCallback(() => {
		const cursor = state?.data.decisions.nextCursor;
		if (!cursor || loadingMore) return;
		const mine = seq.current;
		setLoadingMore(true);
		void fetchKbActivity({ since, before: cursor, limit: KB_ACTIVITY_PAGE }).then((res) => {
			setLoadingMore(false);
			if (mine !== seq.current || !res.ok) return;
			const page = res.data.decisions;
			setState((s) => (s ? { ...s, data: { ...s.data, decisions: mergeDecisionPages(s.data.decisions, page) } } : s));
		});
	}, [state, since, loadingMore]);

	if (load.kind === "unavailable") return <KbActivityUnavailable message={load.message} />;
	if (load.kind === "loading" || !state) return <div className="p-6 text-sm text-muted-foreground" data-testid="kb-activity-view">Loading…</div>;
	return <KbActivityBody state={state} now={now} outcome={outcome} since={since} loadingMore={loadingMore} onOutcome={setOutcome} onSince={setSince} onLoadMore={loadMore} />;
}
