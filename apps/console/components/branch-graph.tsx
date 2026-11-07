"use client";

import { useEffect, useState } from "react";
import { WorkIdChip, lookupWorkItem } from "@/components/work-id-chip";
import { ageLabel, type GitOverview, type OverviewBranch } from "@/src/core";

const STEP = 36;
const LANE_H = 30;
const LABEL_W = 190;
const R = 5;
const COLORS = ["#8b95a7", "#c78bfa", "#5eb0ff", "#4ade80", "#fbbf24", "#f472b6", "#2dd4bf"];
/** A child with up to this many commits gets one dot each; more collapse into one counted dot. */
const MAX_CHILD_DOTS = 3;

function truncate(name: string, max = 28): string {
	return name.length <= max ? name : `${name.slice(0, 10)}…${name.slice(name.length - (max - 11))}`;
}

/**
 * Compressed lane diagram, oldest → newest left → right. The main lane is the thread's branch, one dot per work-item
 * run (its commit count above). Each branch still ahead of it is a lane forking at its real fork point; a fork older
 * than the window sits at a `… N commits` gap marker. Landed branches (0 ahead) have no lane; see the rows below.
 */
export function BranchGraphView({ overview }: { overview: GitOverview }) {
	const lanes = overview.branches.filter((b) => !b.landed);
	if (overview.history.length === 0) return null;
	const gaps = lanes.filter((b) => b.forkIndex === -1).map((b) => b.gap);
	const hasGap = gaps.length > 0;
	const gapLabel = gaps.length === 0 ? "" : `… ${Math.min(...gaps) === Math.max(...gaps) ? Math.max(...gaps) : `${Math.min(...gaps)}–${Math.max(...gaps)}`} commits`;
	const offset = hasGap ? 1 : 0;
	const forkCol = (b: OverviewBranch) => (b.forkIndex === -1 ? 0 : b.forkIndex + offset);
	const dots = (b: OverviewBranch) => (b.ahead <= MAX_CHILD_DOTS ? b.ahead : 1);
	const cols = Math.max(overview.history.length + offset, ...lanes.map((b) => forkCol(b) + 1 + dots(b)));
	const width = LABEL_W + cols * STEP + 6;
	const height = (lanes.length + 1) * LANE_H + 12;
	const x = (col: number) => LABEL_W + col * STEP + STEP / 2;
	const y = (lane: number) => 12 + lane * LANE_H + LANE_H / 2;
	const color = (lane: number) => COLORS[lane % COLORS.length]!;
	const mainKind = overview.main.kind;
	return (
		<svg data-testid="branch-graph" role="img" aria-label="Branch graph" viewBox={`0 0 ${width} ${height}`} width="100%" className="font-mono">
			<g data-testid="branch-graph-lane" data-kind={mainKind}>
				<line x1={LABEL_W} x2={width} y1={y(0)} y2={y(0)} stroke={color(0)} strokeOpacity={0.15} />
				<text x={0} y={y(0) + 4} fontSize={11} fill={color(0)} className="font-semibold">
					<title>{overview.main.name}</title>
					{truncate(overview.main.name)}
				</text>
				{hasGap && (
					<g data-testid="branch-graph-gap">
						<line x1={x(0) - 8} x2={x(0) + 8} y1={y(0)} y2={y(0)} stroke={color(0)} strokeWidth={2} strokeDasharray="2 3" />
						<text x={x(0)} y={y(0) - 9} fontSize={9} textAnchor="start" fill={color(0)} fillOpacity={0.8}>{gapLabel}</text>
					</g>
				)}
				{overview.history.map((h, i) => (
					<g key={h.sha}>
						{(i > 0 || hasGap) && <line x1={x(i + offset - 1)} x2={x(i + offset)} y1={y(0)} y2={y(0)} stroke={color(0)} strokeWidth={2} />}
						<circle data-testid="branch-graph-node" cx={x(i + offset)} cy={y(0)} r={R} fill={color(0)} stroke="var(--popover, #111)" strokeWidth={1}>
							<title>{`${h.workId ?? "other"} · ${h.count} ${h.count === 1 ? "commit" : "commits"}\n${h.sha.slice(0, 7)} ${h.subject}`}</title>
						</circle>
						{h.count > 1 && <text x={x(i + offset)} y={y(0) - 9} fontSize={9} textAnchor="middle" fill={color(0)}>{h.count}</text>}
					</g>
				))}
			</g>
			{lanes.map((b, li) => {
				const lane = li + 1;
				const fx = x(forkCol(b));
				const n = dots(b);
				return (
					<g key={b.name} data-testid="branch-graph-lane" data-kind={b.kind}>
						<line x1={LABEL_W} x2={width} y1={y(lane)} y2={y(lane)} stroke={color(lane)} strokeOpacity={0.15} />
						<text x={0} y={y(lane) + 4} fontSize={11} fill={color(lane)}>
							<title>{b.name}</title>
							{truncate(b.name)}
						</text>
						{Array.from({ length: n }, (_, k) => {
							const cx = x(forkCol(b) + 1 + k);
							const prev = k === 0 ? fx : x(forkCol(b) + k);
							const py = k === 0 ? y(0) : y(lane);
							const mid = (prev + cx) / 2;
							const d = py === y(lane) ? `M${prev} ${py}H${cx}` : `M${prev} ${py}C${mid} ${py} ${mid} ${y(lane)} ${cx} ${y(lane)}`;
							return (
								<g key={k}>
									<path data-testid="branch-graph-edge" d={d} fill="none" stroke={color(lane)} strokeWidth={2} />
									<circle data-testid="branch-graph-node" cx={cx} cy={y(lane)} r={R} fill={color(lane)} stroke="var(--popover, #111)" strokeWidth={1}>
										<title>{`${b.name} · ${b.ahead} ${b.ahead === 1 ? "commit" : "commits"}`}</title>
									</circle>
									{b.ahead > MAX_CHILD_DOTS && <text x={cx + R + 3} y={y(lane) + 3} fontSize={9} fill={color(lane)}>{`${b.ahead} commits`}</text>}
								</g>
							);
						})}
					</g>
				);
			})}
		</svg>
	);
}

/** The main lane's work-item runs, newest first, as chips ("other" for commits without an ID). */
export function HistoryRuns({ overview, limit = 6 }: { overview: GitOverview; limit?: number }) {
	const runs = [...overview.history].reverse();
	return (
		<div data-testid="git-tree-history" className="space-y-0.5">
			{runs.slice(0, limit).map((h) => (
				<div key={h.sha} className="flex items-center gap-1.5">
					{h.workId ? <WorkIdChip id={h.workId} /> : <span className="text-muted-foreground">other</span>}
					<span className="text-muted-foreground">· {h.count} {h.count === 1 ? "commit" : "commits"}</span>
				</div>
			))}
			{runs.length > limit && <div className="text-muted-foreground/70">+{runs.length - limit} older</div>}
		</div>
	);
}

/** The work item title behind a branch (looked up by the full ID parsed from its name), else the branch name. */
function useWorkTitle(workId: string | null): string | undefined {
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

function BranchRow({ branch, nowSec }: { branch: OverviewBranch; nowSec: number }) {
	const title = useWorkTitle(branch.workId);
	return (
		<div data-testid="git-tree-branch-row" data-landed={branch.landed} className={`flex flex-col ${branch.landed ? "opacity-50" : ""}`}>
			<div className="flex min-w-0 items-center gap-1.5">
				{branch.workId && <WorkIdChip id={branch.workId} />}
				<span className="min-w-0 truncate" title={branch.name}>{title ?? truncate(branch.name, 40)}</span>
				{branch.landed && <span data-testid="git-tree-landed" className="shrink-0 rounded border border-border px-1 text-muted-foreground">landed</span>}
				{branch.dirty && <span data-testid="git-tree-branch-dirty" className="shrink-0 rounded border border-amber-500/50 px-1 text-amber-600 dark:text-amber-400">dirty</span>}
			</div>
			<span className="font-mono text-muted-foreground">
				{branch.ahead} ahead · {branch.behind} behind · split {ageLabel(branch.splitAt, nowSec)} · last {ageLabel(branch.lastAt, nowSec)}
			</span>
		</div>
	);
}

/** One row per child branch below the graph. */
export function BranchRows({ overview }: { overview: GitOverview }) {
	if (overview.branches.length === 0) return null;
	const nowSec = Date.now() / 1000;
	return (
		<div data-testid="git-tree-branch-rows" className="space-y-1">
			{overview.branches.map((b) => (
				<BranchRow key={b.name} branch={b} nowSec={nowSec} />
			))}
		</div>
	);
}
