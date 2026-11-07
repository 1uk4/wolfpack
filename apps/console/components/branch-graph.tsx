"use client";

import { useEffect, useState } from "react";
import { WorkIdChip, lookupWorkItem } from "@/components/work-id-chip";
import { ageLabel, agentName, branchShortId, buildCard, candidateWorkIds, featureOfItem, filterRecent, type GitOverview, type OverviewBranch, type RunNode } from "@/src/core";

const ROW_H = 20;
const LANE_W = 16;
const DOT = 8;
const COLORS = ["#8b95a7", "#c78bfa", "#5eb0ff", "#4ade80", "#fbbf24", "#f472b6", "#2dd4bf"];
const GREY = "#6b7280";
const MAIN_X = 8;

type Row =
	| { type: "active"; branch: OverviewBranch; lane: number }
	| { type: "landed"; branch: OverviewBranch }
	| { type: "heading"; text: string }
	| { type: "run"; run: RunNode }
	| { type: "more"; items: number; commits: number };

/** The work item title behind a full ID (looked up like the chips), undefined until known. */
function useWorkTitle(workId: string | null | undefined): string | undefined {
	const [title, setTitle] = useState<string>();
	useEffect(() => {
		if (!workId) return;
		let live = true;
		void lookupWorkItem(workId).then((v) => live && v.kind === "ok" && setTitle(v.item.title));
		return () => {
			live = false;
		};
	}, [workId]);
	return title;
}

/** The work item a feature branch's 7-char id names: tried in every work domain, first hit wins. */
function useBranchWork(shortId: string | null): { id: string; title: string } | undefined {
	const [found, setFound] = useState<{ id: string; title: string }>();
	useEffect(() => {
		if (!shortId) return;
		let live = true;
		void (async () => {
			for (const id of candidateWorkIds(shortId)) {
				const v = await lookupWorkItem(id);
				if (v.kind === "ok") {
					if (live) setFound({ id, title: v.item.title });
					return;
				}
			}
		})();
		return () => {
			live = false;
		};
	}, [shortId]);
	return found;
}

/** Each run's feature (null: loose work), looked up like the chips do (cached). undefined until every lookup is back. */
function useRunFeatures(history: RunNode[]): Record<string, string | null | undefined> | undefined {
	const ids = [...new Set(history.map((r) => r.workId).filter((x): x is string => x !== null))].sort();
	const key = ids.join(",");
	const [done, setDone] = useState<{ key: string; map: Record<string, string | null | undefined> }>();
	useEffect(() => {
		let live = true;
		void Promise.all(ids.map((id) => lookupWorkItem(id))).then((vs) => {
			const map: Record<string, string | null | undefined> = {};
			ids.forEach((id, i) => {
				const v = vs[i]!;
				if (v.kind === "ok") map[id] = featureOfItem(v.item, v.parent);
			});
			if (live) setDone({ key, map });
		});
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return done?.key === key ? done.map : undefined;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A branch's label: the agent name for a subagent, else its work item title, else the branch name. */
function BranchLabel({ branch }: { branch: OverviewBranch }) {
	const work = useBranchWork(branch.kind === "subagent" ? null : branch.shortId);
	const text = branch.kind === "subagent" ? agentName(branch.name) : (work?.title ?? branch.name);
	return (
		<>
			{work && <WorkIdChip id={work.id} />}
			<span className="min-w-0 truncate" title={branch.name}>{text}</span>
		</>
	);
}

function RunLabel({ run }: { run: RunNode }) {
	const title = useWorkTitle(run.workId);
	if (!run.workId) return <span className="min-w-0 truncate text-muted-foreground">no work item</span>;
	return (
		<>
			<WorkIdChip id={run.workId} />
			<span className="min-w-0 truncate">{title ?? ""}</span>
		</>
	);
}

/**
 * One list with a graph gutter, like `git log --graph`: the main lane is a single vertical line through every row;
 * each active child has its own coloured lane rising from the main lane at the bottom of the active block to a dot on
 * its row. Fixed pixel sizes: the card never scales with its width.
 */
export function BranchOverview({ overview }: { overview: GitOverview }) {
	const features = useRunFeatures(overview.history);
	const feature = overview.main.kind === "feature" ? branchShortId(overview.main.name) : null;
	// The recent section shows only this thread's own work; it stays out until the lookups are back (no unfiltered flash).
	const card = buildCard({ ...overview, history: features ? filterRecent(overview.history, feature, features) : [] });
	const rows: Row[] = [];
	card.active.forEach((branch, lane) => rows.push({ type: "active", branch, lane }));
	const activeEnd = rows.length;
	if (card.landed.length > 0) {
		rows.push({ type: "heading", text: "Landed" });
		for (const branch of card.landed) rows.push({ type: "landed", branch });
	}
	if (card.recent.length > 0) {
		rows.push({ type: "heading", text: overview.main.kind === "feature" ? "Recent in this feature" : "Recent in home" });
		for (const run of card.recent) rows.push({ type: "run", run });
		if (card.more.items > 0) rows.push({ type: "more", ...card.more });
	}
	if (rows.length === 0) return null;
	const nowSec = Date.now() / 1000;
	const gutter = MAIN_X + card.active.length * LANE_W + DOT / 2 + 10;
	const height = rows.length * ROW_H;
	const cy = (i: number) => i * ROW_H + ROW_H / 2;
	const laneX = (lane: number) => MAIN_X + (lane + 1) * LANE_W;
	const color = (lane: number) => COLORS[(lane + 1) % COLORS.length]!;
	const blockBottom = activeEnd * ROW_H;
	return (
		<div data-testid="git-tree-overview" className="relative font-mono text-[11px] leading-5" style={{ height, paddingLeft: gutter }}>
			<svg data-testid="branch-graph" aria-hidden width={gutter} height={height} className="absolute left-0 top-0">
				<line x1={MAIN_X} x2={MAIN_X} y1={0} y2={height} stroke={COLORS[0]} strokeWidth={2} />
				{rows.map((r, i) => {
					if (r.type === "active") {
						const x = laneX(r.lane);
						return (
							<g key={r.branch.name} data-testid="branch-graph-lane" data-kind={r.branch.kind}>
								<path d={`M${MAIN_X} ${blockBottom} C${MAIN_X + LANE_W / 2} ${blockBottom} ${x} ${blockBottom} ${x} ${blockBottom - 10} V${cy(i)}`} fill="none" stroke={color(r.lane)} strokeWidth={2} />
								<circle cx={x} cy={cy(i)} r={DOT / 2} fill={color(r.lane)} />
							</g>
						);
					}
					if (r.type === "landed") return <circle key={r.branch.name} data-testid="branch-graph-landed" cx={MAIN_X} cy={cy(i)} r={DOT / 2 - 1} fill={GREY} />;
					if (r.type === "run") return <circle key={r.run.sha} data-testid="branch-graph-node" cx={MAIN_X} cy={cy(i)} r={DOT / 2} fill={COLORS[0]} stroke="var(--popover, #111)" strokeWidth={1} />;
					return null;
				})}
			</svg>
			{rows.map((r, i) => {
				const key = r.type === "active" || r.type === "landed" ? r.branch.name : r.type === "run" ? r.run.sha : `${r.type}-${i}`;
				return (
					<div key={key} style={{ height: ROW_H }} className="flex items-center gap-1.5 whitespace-nowrap">
						{r.type === "heading" && <span className="text-[10px] uppercase tracking-widest text-muted-foreground/70">{r.text}</span>}
						{r.type === "active" && (
							<div data-testid="git-tree-branch-row" data-landed="false" className="flex min-w-0 items-center gap-1.5">
								<BranchLabel branch={r.branch} />
								<span className="shrink-0 text-emerald-600 dark:text-emerald-400">+{r.branch.ahead}</span>
								<span className="shrink-0 text-muted-foreground">−{r.branch.behind} · {ageLabel(r.branch.lastAt, nowSec)}</span>
								{r.branch.dirty && <span data-testid="git-tree-branch-dirty" className="shrink-0 text-amber-600 dark:text-amber-400">· dirty</span>}
							</div>
						)}
						{r.type === "landed" && (
							<div data-testid="git-tree-branch-row" data-landed="true" className="flex min-w-0 items-center gap-1.5 opacity-50">
								<BranchLabel branch={r.branch} />
								<span className="shrink-0 text-muted-foreground">· {ageLabel(r.branch.lastAt, nowSec)}</span>
							</div>
						)}
						{r.type === "run" && (
							<div data-testid="git-tree-run" className="flex min-w-0 flex-1 items-center gap-1.5">
								<RunLabel run={r.run} />
								<span className="ml-auto shrink-0 pl-2 text-muted-foreground">
									{r.run.count} · <span className="text-emerald-600 dark:text-emerald-400">+{r.run.added}</span> <span className="text-red-600 dark:text-red-400">−{r.run.removed}</span> · {ageLabel(r.run.time ?? null, nowSec)}
								</span>
							</div>
						)}
						{r.type === "more" && <span data-testid="git-tree-more" className="text-muted-foreground">+ {plural(r.items, "more work item")} · {plural(r.commits, "commit")}</span>}
					</div>
				);
			})}
		</div>
	);
}
