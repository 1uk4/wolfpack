"use client";

/**
 * The KB activity page body ("KB life"): the live map (the graph, where the memory pipeline plays as motion) beside the LOG of the same
 * events. Map ~70% / log ~30%; stacked on a phone (map above, log below). The log is the ledger history (seed rows) plus the live
 * pack.activity events; duplicates fold into one row with a count. Hovering or selecting a row rings its wolf / node / flying topic /
 * curator on the map (the hover bus in graph/live/kb-life-store). Power-user details (ids, section, outcome, reason, timings, tokens) stay
 * hidden until a row is selected (panel; a bottom sheet on a phone) or the Details toggle is on.
 */
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowUpRightIcon, BanIcon, CirclePauseIcon, CirclePlusIcon, EyeIcon, GitMergeIcon, InfoIcon, LayersIcon, LoaderIcon, XIcon, type LucideIcon } from "lucide-react";
import {
	KB_ACTIVITY_SINCE,
	LOG_VERB_LABEL,
	domainBlocks,
	entryHref,
	groupRows,
	kbAge,
	mergeSeed,
	type DomainExtra,
	type KbActivityResponse,
	type KbActivitySince,
	type KbLogRow,
	type KbLogVerb,
} from "@/src/core";
import { parseLedgerTime } from "@wolfpack/protocol/ledger-time";
import { Hint } from "@/components/ui/hint";
import { GraphHome } from "../graph/graph-home";
import { setKbHover, startKbDemo, useKbLiveRows } from "../graph/live/kb-life-store";

const SINCE_MS: Record<string, number> = { "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const MAX_ROWS = 200;

const VERB_STYLE: Record<KbLogVerb, { icon: LucideIcon; color: string }> = {
	observe: { icon: EyeIcon, color: "#8b9bb4" },
	consolidate: { icon: LayersIcon, color: "#b69cff" },
	promote: { icon: ArrowUpRightIcon, color: "#4c9dff" },
	processing: { icon: LoaderIcon, color: "#e0a526" },
	created: { icon: CirclePlusIcon, color: "#43d17a" },
	merged: { icon: GitMergeIcon, color: "#ff8fb1" },
	rejected: { icon: BanIcon, color: "#e5645a" },
	parked: { icon: CirclePauseIcon, color: "#9a9fab" },
};

const OUTCOME_VERB: Record<string, KbLogVerb> = { create: "created", merge: "merged", unchanged: "merged", reject: "rejected", parked: "parked" };

/** The ledger's history as log rows (one per decision / change), grouped by domain like the live ones. */
export function seedRowsOf(data: KbActivityResponse, extras?: Readonly<Record<string, DomainExtra>>): KbLogRow[] {
	const out: KbLogRow[] = [];
	for (const b of domainBlocks(data, extras)) {
		for (const r of b.rows) {
			const verb = (r.outcome && OUTCOME_VERB[r.outcome]) || "merged";
			const at = parseLedgerTime(r.at);
			if (Number.isNaN(at)) continue;
			out.push({
				key: `seed-${r.key}`,
				verb,
				domain: b.domain,
				title: r.title,
				at,
				firstAt: at,
				n: 1,
				fold: `${verb}|${r.entryId ?? r.title}`,
				focus: r.entryId ? { target: { kind: "kb-entry", id: r.entryId, domain: b.domain } } : r.wolf ? { wolf: r.wolf } : {},
				...(r.wolf ? { wolf: r.wolf } : {}),
				ids: [r.key, ...(r.entryId ? [r.entryId] : []), ...(r.denTopicId ? [r.denTopicId] : [])],
				...(r.outcome ? { outcome: r.outcome } : {}),
				seed: true,
			});
		}
	}
	return out;
}

const domainColor = (d: string | null): string => {
	if (d === null) return "#8b909c";
	let h = 0;
	for (const c of d) h = (h * 31 + c.charCodeAt(0)) % 360;
	return `hsl(${h} 60% 60%)`;
};

/** The row's secondary facts (ids, section, outcome, reason, timings, tokens), the power-user view. */
export function detailLines(r: KbLogRow): string[] {
	const out: string[] = [];
	if (r.outcome) out.push(`outcome ${r.outcome}`);
	if (r.section) out.push(`section ${r.section}`);
	if (r.reason) out.push(`reason ${r.reason}`);
	if (r.count !== undefined) out.push(`count ${r.count}`);
	if (r.ms !== undefined) out.push(`${r.ms} ms`);
	if (r.tokens !== undefined) out.push(`${r.tokens} tokens`);
	if (r.ids.length) out.push(`ids ${r.ids.join(", ")}`);
	return out;
}

function LogRowView({ row, now, selected, details, onSelect }: { row: KbLogRow; now: number; selected: boolean; details: boolean; onSelect: () => void }) {
	const v = VERB_STYLE[row.verb];
	const Icon = v.icon;
	// A fresh row (or one whose count just grew) flashes, then eases back: a transition, not a keyframe; reduced motion shows no flash.
	const [flash, setFlash] = useState(Date.now() - row.at < 1500 && !row.seed);
	const first = useRef(true);
	useEffect(() => {
		if (!first.current || !flash) setFlash(!row.seed && Date.now() - row.at < 1500);
		first.current = false;
		const t = setTimeout(() => setFlash(false), 60);
		return () => clearTimeout(t);
	}, [row.at, row.n]); // eslint-disable-line react-hooks/exhaustive-deps
	return (
		<li data-testid="kb-log-row" data-verb={row.verb} data-count={row.n} data-selected={selected ? "true" : undefined}>
			<button
				type="button"
				onClick={onSelect}
				onMouseEnter={() => setKbHover(row.focus)}
				onMouseLeave={() => setKbHover(null)}
				className={`flex min-h-11 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-[12px] transition-colors duration-[1400ms] ease-out motion-reduce:transition-none md:min-h-7 ${flash ? "bg-primary/30 duration-0" : selected ? "bg-accent" : "hover:bg-accent/60"}`}
			>
				<Icon className="size-3.5 shrink-0" style={{ color: v.color }} aria-label={LOG_VERB_LABEL[row.verb]} />
				<span className="min-w-0 flex-1 truncate text-foreground">{row.title}</span>
				<span className="shrink-0 text-[10px] text-muted-foreground">
					{row.n > 1 ? `×${row.n} · ` : ""}
					{kbAge(Math.max(0, now - row.at))}
				</span>
			</button>
			{details ? <div className="px-2 pb-1 pl-7 text-[10px] leading-snug text-muted-foreground" data-testid="kb-log-details">{detailLines(row).join(" · ")}</div> : null}
		</li>
	);
}

function DetailsPanel({ row, now, onClose }: { row: KbLogRow; now: number; onClose: () => void }) {
	const entry = row.focus.target?.kind === "kb-entry" ? row.focus.target.id : undefined;
	const rows: [string, string][] = [
		["Step", LOG_VERB_LABEL[row.verb]],
		...(row.domain ? ([["Domain", row.domain]] as [string, string][]) : []),
		...(row.wolf ? ([["Wolf", row.wolf]] as [string, string][]) : []),
		...(row.outcome ? ([["Outcome", row.outcome]] as [string, string][]) : []),
		...(row.section ? ([["Section", row.section]] as [string, string][]) : []),
		...(row.reason ? ([["Reason", row.reason]] as [string, string][]) : []),
		...(row.ms !== undefined ? ([["Took", `${row.ms} ms`]] as [string, string][]) : []),
		...(row.tokens !== undefined ? ([["Tokens", String(row.tokens)]] as [string, string][]) : []),
		...(row.n > 1 ? ([["Times", `${row.n} (${kbAge(Math.max(0, now - row.firstAt))} → ${kbAge(Math.max(0, now - row.at))} ago)`]] as [string, string][]) : []),
		["Ids", row.ids.join(", ")],
	];
	return (
		<div
			data-testid="kb-log-panel"
			className="fixed inset-x-0 bottom-0 z-30 max-h-[55%] overflow-auto rounded-t-2xl border border-border/50 bg-background/80 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-[12px] shadow-xl backdrop-blur-xl md:static md:z-auto md:max-h-56 md:rounded-xl md:shadow-none"
		>
			<div className="mb-1.5 flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{row.title}</span>
				{entry ? (
					<Hint label="Open entry">
						<Link href={entryHref(entry)} aria-label="Open entry" className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground md:size-7">
							<ArrowUpRightIcon className="size-4" />
						</Link>
					</Hint>
				) : null}
				<Hint label="Close">
					<button type="button" aria-label="Close" onClick={onClose} className="flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground md:size-7">
						<XIcon className="size-4" />
					</button>
				</Hint>
			</div>
			<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
				{rows.map(([k, v]) => (
					<div key={k} className="contents">
						<dt className="text-muted-foreground">{k}</dt>
						<dd className="min-w-0 break-words text-foreground">{v}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

/** The log column. `seed` is the ledger history; the live rows come from the shared feed. */
export function KbLifeLog({ seed, now, since, onSince, notice, sweeping }: { seed: KbLogRow[]; now: number; since: KbActivitySince; onSince?: (s: KbActivitySince) => void; notice?: React.ReactNode; sweeping?: boolean }) {
	const live = useKbLiveRows();
	const [details, setDetails] = useState(false);
	const [sel, setSel] = useState<string | null>(null);
	const rows = useMemo(() => {
		const cut = SINCE_MS[since];
		return mergeSeed(live, seed).filter((r) => cut === undefined || now - r.at <= cut).slice(0, MAX_ROWS);
	}, [live, seed, since, now]);
	const selected = rows.find((r) => r.key === sel) ?? null;
	// The map follows the selection while nothing is hovered.
	useEffect(() => {
		setKbHover(selected?.focus ?? null);
		return () => setKbHover(null);
	}, [selected?.key]); // eslint-disable-line react-hooks/exhaustive-deps
	const groups = useMemo(() => groupRows(rows), [rows]);
	const seg = (on: boolean) => `rounded-md px-2 py-0.5 text-[11px] ${on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`;
	return (
		<aside className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/50 bg-background/60 backdrop-blur-xl" data-testid="kb-life-log">
			<div className="flex items-center gap-2 border-b border-border/50 p-2">
				<span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
					KB activity{sweeping ? <span className="ml-2 font-normal text-muted-foreground" data-testid="kb-sweeping">sweeping…</span> : null}
				</span>
				<span className="inline-flex gap-0.5 rounded-lg bg-muted/70 p-0.5" data-testid="kb-since">
					{KB_ACTIVITY_SINCE.map((s) => (
						<button key={s} type="button" aria-pressed={since === s} data-since={s} className={seg(since === s)} onClick={() => onSince?.(s)}>
							{s}
						</button>
					))}
				</span>
				<Hint label="Details">
					<button type="button" aria-label="Details" aria-pressed={details} onClick={() => setDetails((d) => !d)} className={`flex size-8 items-center justify-center rounded-md md:size-7 ${details ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
						<InfoIcon className="size-4" />
					</button>
				</Hint>
			</div>
			{notice}
			<div className="min-h-0 flex-1 overflow-auto px-1.5 pb-2" data-testid="kb-log-rows">
				{groups.length === 0 ? <p className="p-3 text-[12px] text-muted-foreground" data-testid="kb-log-empty">No activity in this range.</p> : null}
				{groups.map((g) => (
					<section key={g.domain ?? "wolves"} data-domain={g.domain ?? "wolves"}>
						<h3 className="mx-1 mb-0.5 mt-2 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
							<i className="inline-block size-1.5 rounded-full" style={{ background: domainColor(g.domain) }} />
							{g.domain ?? "wolves"}
						</h3>
						<ul>
							{g.rows.map((r) => (
								<LogRowView key={r.key} row={r} now={now} selected={sel === r.key} details={details} onSelect={() => setSel((c) => (c === r.key ? null : r.key))} />
							))}
						</ul>
					</section>
				))}
			</div>
			{selected ? <DetailsPanel row={selected} now={now} onClose={() => setSel(null)} /> : null}
		</aside>
	);
}

/** Map + log. The map is the graph itself (the same live layer), so /graph shows the same motion. `?kbdemo=1` feeds a scripted sample cycle. */
export function KbLifeBody({ data, extras, now, since, onSince, notice, sweeping }: { data: KbActivityResponse; extras?: Readonly<Record<string, DomainExtra>>; now: number; since: KbActivitySince; onSince?: (s: KbActivitySince) => void; notice?: React.ReactNode; sweeping?: boolean }) {
	const demo = useSearchParams()?.get("kbdemo") === "1";
	useEffect(() => (demo ? startKbDemo() : undefined), [demo]);
	const seed = useMemo(() => seedRowsOf(data, extras), [data, extras]);
	return (
		<div className="flex h-full min-h-0 w-full flex-col gap-2 p-2 md:flex-row" data-testid="kb-activity-view">
			<div className="relative min-h-0 min-w-0 flex-[5] overflow-hidden rounded-xl border border-border/50 md:flex-[7]" data-testid="kb-life-map">
				<GraphHome />
			</div>
			<div className="flex min-h-0 min-w-0 flex-[4] flex-col md:flex-[3]">
				<KbLifeLog seed={seed} now={now} since={since} onSince={onSince} notice={notice} sweeping={sweeping} />
			</div>
		</div>
	);
}
