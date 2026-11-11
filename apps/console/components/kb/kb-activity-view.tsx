"use client";

/**
 * The KB activity page body (/kb-activity), served by the hub's own ledger: one block per domain (entries, waiting, contributing wolves,
 * recent decisions and changes tagged with the wolf) and a Needs attention strip for bad / unroutable contributions. The 7d/30d/all range
 * applies to every block. Live: the app-wide event stream carries the curator's sweep_* frames (hub-event); sweep_item folds in
 * optimistically, sweep_finished / kb.changed / resync refetch (debounced, with a request sequence so a stale answer never lands), and a
 * 60 s poll is the fallback. 'show all' pages one domain (50 per page) through the hub's `domain` query.
 */
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	KB_ACTIVITY_ATTENTION_ROWS,
	KB_ACTIVITY_OVERVIEW,
	KB_ACTIVITY_PAGE,
	KB_ACTIVITY_SINCE,
	applyHubEvent,
	attentionGroups,
	contributionList,
	curatorNote,
	curatorStuck,
	hubIsOlder,
	domainBlocks,
	entryHref,
	kbAge,
	kbRelativeTime,
	reconcileActivity,
	needsRefetch,
	type AttentionGroup,
	type ContributionRow,
	type DomainBlock,
	type DomainExtra,
	type FeedRow,
	type KbActivityResponse,
	type KbActivitySince,
	type KbActivityState,
} from "@/src/core";
import { fetchKbActivity } from "./kb-activity-client";
import { useOptionalServerEvent, useOptionalServerResync } from "../shell/server-events";
import { ledgerTimeIso, parseLedgerTime } from "@wolfpack/protocol/ledger-time";

const absolute = (iso: string): string => {
	const d = new Date(ledgerTimeIso(iso));
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export function KbActivityUnavailable({ message }: { message: string }) {
	return (
		<div className="p-6 font-ui text-sm text-muted-foreground" data-testid="kb-activity-unavailable">
			<p>KB activity is unavailable.</p>
			<p className="mt-1 text-[12px] text-muted-foreground/70">{message}</p>
		</div>
	);
}

function Row({ row, now }: { row: FeedRow; now: number }) {
	return (
		<li className="flex items-baseline gap-2 text-[12px]" data-outcome={row.outcome} data-action={row.outcome ? undefined : row.label} data-decision={row.outcome ? row.key : undefined} data-provisional={row.provisional ? "true" : undefined}>
			<span className="w-24 shrink-0 text-muted-foreground" data-testid="kb-row-label">
				{row.mark} {row.label}
			</span>
			{row.entryId ? (
				<Link href={entryHref(row.entryId)} className="truncate text-foreground underline underline-offset-2">
					{row.title}
				</Link>
			) : (
				<span className="truncate text-foreground">{row.title}</span>
			)}
			{row.superseded > 0 ? <span className="shrink-0 text-[11px] text-muted-foreground/50">replaced {row.superseded}</span> : null}
			<span className="ml-auto flex shrink-0 gap-3 text-muted-foreground/60">
				{row.wolf ? <span>{row.wolf}</span> : null}
				<span title={absolute(row.at)}>{kbAge(Math.max(0, now - parseLedgerTime(row.at)))}</span>
			</span>
		</li>
	);
}

export function DomainBlockView({ block, now, loading, onShowAll }: { block: DomainBlock; now: number; loading?: boolean; onShowAll?: (domain: string) => void }) {
	const last = block.lastChangeAt ? ` · last change ${kbRelativeTime(block.lastChangeAt, now)}` : "";
	return (
		<section className="mb-6" data-testid="kb-domain" data-domain={block.domain}>
			<h2 className="mb-1 font-ui text-[11px] uppercase tracking-wide text-muted-foreground">
				{block.domain}
				<span className="ml-3 normal-case tracking-normal text-muted-foreground/70" data-testid="kb-domain-summary">
					{block.entries ?? "–"} {block.entries === 1 ? "entry" : "entries"} · {block.waiting ?? "–"} waiting{last}
				</span>
			</h2>
			<div className="ml-3 text-[12px]">
				<div className="mb-1 text-muted-foreground" data-testid="kb-contributors">
					<span className="mr-2 text-muted-foreground/60">Contributors</span>
					{block.contributors.length === 0 ? <span className="text-muted-foreground/50">none in range</span> : block.contributors.map((c) => `${c.wolf} ${c.count}`).join(" · ")}
				</div>
				{block.rows.length === 0 ? (
					<p className="text-muted-foreground/60" data-testid="kb-domain-empty">No activity in this range.</p>
				) : (
					<ul className="space-y-0.5" data-testid="kb-domain-rows">
						{block.rows.map((r) => (
							<Row key={r.key} row={r} now={now} />
						))}
					</ul>
				)}
				{block.more ? (
					<button type="button" className="mt-1 text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50" disabled={loading} onClick={() => onShowAll?.(block.domain)} data-testid="kb-show-all" data-domain={block.domain}>
						{loading ? "Loading…" : block.expanded ? "load more →" : `show all ${block.decided} →`}
					</button>
				) : null}
			</div>
		</section>
	);
}

/** The live Contributions list: each incoming item by wolf, topic, domain and age, with queued / in progress / decided. */
export function ContributionsList({ data, now }: { data: KbActivityResponse; now: number }) {
	const { rows, more }: { rows: ContributionRow[]; more: number } = contributionList(data, now);
	return (
		<section className="mb-6" data-testid="kb-contributions">
			<h2 className="mb-1 font-ui text-[11px] uppercase tracking-wide text-muted-foreground">Contributions</h2>
			{rows.length === 0 ? (
				<p className="ml-3 text-[12px] text-muted-foreground/60" data-testid="kb-contributions-empty">Nothing incoming.</p>
			) : (
				<ul className="ml-3 space-y-0.5 text-[12px]">
					{rows.map((r) => (
						<li key={r.key} className="flex items-baseline gap-2" data-state={r.state} data-outcome={r.outcome} data-wolf={r.wolf} data-topic={r.denTopicId}>
							<span className="w-28 shrink-0 text-muted-foreground" data-testid="kb-contribution-state">
								{r.label}
							</span>
							<span className="shrink-0 text-foreground">{r.wolf}</span>
							<span className="truncate text-foreground">{r.denTopicId}</span>
							{r.domain ? <span className="shrink-0 text-muted-foreground/70">{r.domain}</span> : null}
							{r.route ? <span className="truncate text-muted-foreground" data-testid="kb-contribution-route">{r.route}</span> : null}
							{r.entryId ? (
								<Link href={entryHref(r.entryId)} className="truncate text-foreground underline underline-offset-2">
									{r.entryId}
								</Link>
							) : r.reason ? (
								<span className="truncate text-muted-foreground/70">{r.reason}</span>
							) : null}
							<span className="ml-auto shrink-0 text-muted-foreground/60" title={absolute(new Date(r.at).toISOString())}>
								{kbAge(Math.max(0, now - r.at))}
							</span>
						</li>
					))}
					{more > 0 ? <li className="text-muted-foreground/50" data-testid="kb-contributions-more">+{more} more</li> : null}
				</ul>
			)}
		</section>
	);
}

export function NeedsAttention({ data, now }: { data: KbActivityResponse; now: number }) {
	const groups: AttentionGroup[] = attentionGroups(data);
	if (groups.length === 0) return null;
	return (
		<section className="mb-6" data-testid="kb-attention">
			<h2 className="mb-1 font-ui text-[11px] uppercase tracking-wide text-muted-foreground">Needs attention</h2>
			<ul className="ml-3 space-y-1 text-[12px]">
				{groups.map((g) => (
					<li key={g.wolf} data-wolf={g.wolf}>
						<details>
							<summary className="cursor-pointer select-none">
								<span className="mr-3 text-foreground">{g.wolf}</span>
								<span className="text-muted-foreground">{g.summary}</span>
								{g.truncated ? <span className="ml-2 text-muted-foreground/50">latest {g.items.length}</span> : null}
							</summary>
							<ul className="ml-4 mt-0.5 space-y-0.5 text-muted-foreground/80">
								{g.items.slice(0, KB_ACTIVITY_ATTENTION_ROWS).map((i) => (
									<li key={i.key} data-kind={i.kind}>
										{i.outcome ? `${i.outcome} · ` : "bad · "}
										<span className="text-foreground">{i.denTopicId ?? "(unknown topic)"}</span>
										{i.domainHint ? ` · hint ${i.domainHint}` : ""} · {i.reason} · <span title={absolute(i.at)}>{kbAge(Math.max(0, now - parseLedgerTime(i.at)))}</span>
									</li>
								))}
								{g.items.length > KB_ACTIVITY_ATTENTION_ROWS ? <li className="text-muted-foreground/50">and {g.items.length - KB_ACTIVITY_ATTENTION_ROWS} more</li> : null}
							</ul>
						</details>
					</li>
				))}
			</ul>
		</section>
	);
}

/** The pure body (SSR-pinnable). */
export function KbActivityBody({
	state,
	now,
	since = "30d",
	extras,
	loadingDomain,
	onSince,
	onShowAll,
}: {
	state: KbActivityState;
	now: number;
	since?: KbActivitySince;
	extras?: Readonly<Record<string, DomainExtra>>;
	loadingDomain?: string | null;
	onSince?: (s: KbActivitySince) => void;
	onShowAll?: (domain: string) => void;
}) {
	const { data } = state;
	const note = curatorNote(data);
	const stuckSince = curatorStuck(data);
	const blocks = domainBlocks(data, extras);
	const chip = (active: boolean) => `rounded border px-1.5 py-0.5 text-[11px] ${active ? "border-foreground/40 bg-accent text-foreground" : "border-border text-muted-foreground hover:text-foreground"}`;
	return (
		<div className="mx-auto max-w-4xl p-6 font-ui" data-testid="kb-activity-view">
			<h1 className="mb-4 flex items-baseline gap-3 text-base text-foreground">
				KB activity
				{state.sweeping ? <span className="text-[12px] text-muted-foreground" data-testid="kb-sweeping">sweeping…</span> : null}
				<span className="ml-auto flex gap-1" data-testid="kb-since">
					{KB_ACTIVITY_SINCE.map((s) => (
						<button key={s} type="button" className={chip(since === s)} aria-pressed={since === s} data-since={s} onClick={() => onSince?.(s)}>
							{s}
						</button>
					))}
				</span>
			</h1>
			{stuckSince ? (
				<div role="alert" className="mb-4 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300" data-testid="kb-curator-stuck">
					<p>Curator stuck since {new Date(parseLedgerTime(stuckSince)).toLocaleString()} ({kbRelativeTime(stuckSince, now)})</p>
					<p className="mt-0.5 text-[12px] opacity-80">The sweep ran past its time budget and hasn't stopped; new sweeps are skipped until it does.</p>
				</div>
			) : null}
			{note ? <p className="mb-4 text-sm text-muted-foreground" data-testid="kb-curator-note">{note}</p> : null}
			{hubIsOlder(data) ? <p className="mb-4 text-[12px] text-muted-foreground/70" data-testid="kb-hub-older">The hub is older than this console: entry and waiting counts are unavailable.</p> : null}
			<ContributionsList data={data} now={now} />
			{blocks.length === 0 ? <p className="mb-6 text-sm text-muted-foreground" data-testid="kb-domains-empty">No domains yet.</p> : null}
			{blocks.map((b) => (
				<DomainBlockView key={b.domain} block={b} now={now} loading={loadingDomain === b.domain} {...(onShowAll ? { onShowAll } : {})} />
			))}
			<NeedsAttention data={data} now={now} />
		</div>
	);
}

type Load = { kind: "loading" } | { kind: "unavailable"; message: string } | { kind: "ready" };

export interface KbActivityTiming {
	/** Trailing debounce of event-driven refetches (default 500 ms). */
	debounceMs?: number;
	/** Fallback poll (default 60 s). */
	pollMs?: number;
}

export function KbActivityView({ timing }: { timing?: KbActivityTiming } = {}) {
	const debounceMs = timing?.debounceMs ?? 500;
	const pollMs = timing?.pollMs ?? 60_000;
	const [load, setLoad] = useState<Load>({ kind: "loading" });
	const [state, setState] = useState<KbActivityState | null>(null);
	const [since, setSince] = useState<KbActivitySince>("30d");
	const [extras, setExtras] = useState<Record<string, DomainExtra>>({});
	const [loadingDomain, setLoadingDomain] = useState<string | null>(null);
	const [now, setNow] = useState(() => Date.now());
	/** Refetch sequence: only the newest overview request may land. */
	const seq = useRef(0);
	/** Bumped when `since` changes (and on unmount): results fetched for another range are never used. */
	const gen = useRef(0);
	const extrasRef = useRef<Record<string, DomainExtra>>({});
	extrasRef.current = extras;
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refetch = useCallback(() => {
		const mine = ++seq.current;
		const myGen = gen.current;
		void fetchKbActivity({ since, limit: KB_ACTIVITY_OVERVIEW }).then((res) => {
			if (mine !== seq.current || myGen !== gen.current) return; // a newer request (or range) owns the screen
			if (res.ok) {
				setState((prev) => reconcileActivity(prev, res.data, { since }));
				setLoad({ kind: "ready" });
			} else {
				const message = res.reason === "unauthorized" ? (res.hubAuth ? "This browser is not paired with the hub." : "Unauthorized.") : res.message;
				setLoad((prev) => (res.reason === "unavailable" || res.reason === "unauthorized" || prev.kind !== "ready" ? { kind: "unavailable", message } : prev));
			}
		});
	}, [since]);

	const refetchSoon = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			timer.current = null;
			refetch();
		}, debounceMs);
	}, [refetch, debounceMs]);

	// A new range starts over: expanded domains and in-flight requests of the old range are dropped.
	useEffect(() => {
		gen.current++;
		setLoad({ kind: "loading" });
		setState(null);
		setExtras({});
		setLoadingDomain(null);
		refetch();
		return () => {
			seq.current++;
			if (timer.current) clearTimeout(timer.current);
			timer.current = null;
		};
	}, [refetch]);

	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 30_000);
		const poll = setInterval(refetch, pollMs);
		return () => {
			clearInterval(id);
			clearInterval(poll);
		};
	}, [refetch, pollMs]);

	useOptionalServerEvent("hub-event", ({ frame }) => {
		setState((s) => (s ? applyHubEvent(s, frame) : s));
		if (needsRefetch(frame)) refetchSoon();
	});
	// A reconnect: any request already in flight predates the gap, so invalidate it now (not only when the debounced refetch starts).
	useOptionalServerResync(() => {
		seq.current++;
		refetchSoon();
	});

	/** First click loads the domain's first page; further clicks continue from its cursor. */
	const showAll = useCallback(
		(domain: string) => {
			const cur = extrasRef.current[domain];
			if (cur && !cur.nextCursor) return;
			const myGen = gen.current;
			setLoadingDomain(domain);
			void fetchKbActivity({ since, domain, limit: KB_ACTIVITY_PAGE, ...(cur?.nextCursor ? { before: cur.nextCursor } : {}) }).then((res) => {
				if (myGen !== gen.current) return; // another range
				setLoadingDomain((d) => (d === domain ? null : d));
				if (!res.ok) return;
				const changes = res.data.changes.domains.find((c) => c.domain === domain)?.items ?? [];
				const next: DomainExtra = { items: [...(cur?.items ?? []), ...res.data.decisions.items], changes: cur?.changes ?? changes };
				if (res.data.decisions.nextCursor) next.nextCursor = res.data.decisions.nextCursor;
				setExtras((e) => ({ ...e, [domain]: next }));
			});
		},
		[since],
	);

	if (load.kind === "unavailable") return <KbActivityUnavailable message={load.message} />;
	if (load.kind === "loading" || !state) return <div className="p-6 text-sm text-muted-foreground" data-testid="kb-activity-view">Loading…</div>;
	return <KbActivityBody state={state} now={now} since={since} extras={extras} loadingDomain={loadingDomain} onSince={setSince} onShowAll={showAll} />;
}
