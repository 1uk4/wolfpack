"use client";

import { useEffect, useState } from "react";
import { WorkIdChip, lookupWorkItem } from "@/components/work-id-chip";
import { agentName, branchShortId, buildMoments, candidateWorkIds, featureOfItem, shipMoments, swimLanes, timeScale, type GitOverview, type Moment, type ShipSubject, type SwimLane } from "@/src/core";

const LANE_H = 22;
const LABEL_W = 150;
const TOP = 16;
const BOTTOM = 18;
const PAD_L = 8;
const PAD_R = 70;
const DOT = 4;
const MAX_LOOKUPS = 40;
const COLORS: Record<SwimLane["role"], string> = { child: "#fbbf24", main: "#c78bfa", sibling: "#4ade80", feature: "#4ade80", home: "#e5e7eb", stable: "#9ca3af" };
const BLUE = "#5eb0ff";
const YELLOW = "#f5c542";
const DAY = 86400;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** The work item a feature branch's 7-char id names: tried in every work domain, first hit wins. */
function useBranchTitle(shortId: string | null): string | undefined {
	const [title, setTitle] = useState<string>();
	useEffect(() => {
		if (!shortId) return;
		let live = true;
		void (async () => {
			for (const id of candidateWorkIds(shortId)) {
				const v = await lookupWorkItem(id);
				if (v.kind === "ok") {
					if (live) setTitle(v.item.title);
					return;
				}
			}
		})();
		return () => {
			live = false;
		};
	}, [shortId]);
	return title;
}

/** A lane's label: the agent name for a subagent, the work item title for a feature, else the branch name. */
function LaneLabel({ lane, y }: { lane: SwimLane; y: number }) {
	const subagent = lane.role === "child";
	const title = useBranchTitle(!subagent && (lane.role === "main" || lane.role === "sibling" || lane.role === "feature") ? branchShortId(lane.name) : null);
	const text = subagent ? agentName(lane.name) : (title ?? lane.name);
	return (
		<text x={PAD_L} y={y + 4} fontSize={11} fill={COLORS[lane.role]} fontWeight={lane.bold ? 600 : 400}>
			<title>{lane.name}</title>
			{clip(text, 20)}
		</text>
	);
}

/**
 * The work items behind the landed rings. Fast-forward merges leave no git trace, so a landing is the work item's ship
 * time: the item's `updated` date (the last event on a finished item). Candidates are the work IDs in the main lane's
 * commit subjects plus the ids of branches with nothing ahead. Cached lookups (the chips'); empty until they resolve.
 */
export function useRings(overview: GitOverview | undefined, nowSec: number): Moment[] {
	const [rings, setRings] = useState<Moment[]>([]);
	const feature = overview?.main.kind === "feature" ? branchShortId(overview.main.name) : null;
	const ids = overview ? [...new Set(overview.history.map((r) => r.workId).filter((x): x is string => x !== null))].slice(0, MAX_LOOKUPS) : [];
	const shorts = overview ? [...overview.branches, ...overview.siblings].filter((b) => b.landed && b.shortId).map((b) => b.shortId!) : [];
	const active = overview ? [...overview.branches, ...overview.siblings].filter((b) => !b.landed && b.shortId).map((b) => b.shortId!) : [];
	const key = [overview?.main.name ?? "", ...ids, "|", ...shorts, "|", ...active].join(",");
	useEffect(() => {
		if (!overview) return;
		let live = true;
		void (async () => {
			const subjects: ShipSubject[] = [];
			const take = (v: Awaited<ReturnType<typeof lookupWorkItem>>) => {
				if (v.kind !== "ok") return;
				// A feature thread rings child tasks; home rings the feature the item belongs to (itself, or its parent).
				const rec = feature ? v.item : featureOfItem(v.item, v.parent) === null ? null : v.item.kind === "feature" ? v.item : v.parent;
				if (rec) subjects.push({ id: rec.id, title: rec.title, kind: rec.kind, stage: rec.stage, updated: rec.updated, partOf: rec.partOf ?? null });
			};
			for (const id of ids) take(await lookupWorkItem(id));
			for (const short of shorts) {
				for (const id of candidateWorkIds(short)) {
					const v = await lookupWorkItem(id);
					if (v.kind === "ok") {
						take(v);
						break;
					}
				}
			}
			if (live) setRings(shipMoments(subjects, { feature, nowSec, activeShortIds: active }));
		})();
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return rings;
}

const dayLabel = (t: number, days: number): string => {
	const d = new Date(t * 1000);
	return days <= 7 ? d.toLocaleDateString(undefined, { weekday: "short" }) : `${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * Time swimlanes of significant moments, left to right, "now" at the right edge. Fixed pixel sizes (11px text, 22px
 * lanes): the card never scales with its width. Quiet stretches are squeezed so busy days get the room.
 */
export function Swimlanes({ overview, rings, days, nowSec }: { overview: GitOverview; rings: Moment[]; days: number; nowSec: number }) {
	const lanes = swimLanes(overview);
	const start = nowSec - days * DAY;
	const moments = buildMoments(overview, rings, nowSec, days);
	const sinceOf = (s: { count: number; since: number | null } | null) => (s && s.count > 0 && s.since !== null ? s.since : null);
	const unreleasedSince = sinceOf(overview.unreleased);
	const unmergedSince = overview.main.kind === "feature" ? sinceOf(overview.unmerged) : null;
	const times = [...moments.map((m) => m.at), ...[unreleasedSince, unmergedSince].filter((t): t is number => t !== null && t > start)];
	const scale = timeScale(times, start, nowSec);
	const x0 = LABEL_W;
	const x = (t: number) => x0 + scale.x(t);
	const x1 = x(nowSec);
	const width = x1 + PAD_R;
	const height = TOP + lanes.length * LANE_H + BOTTOM;
	const laneIndex = new Map(lanes.map((l, i) => [l.name, i]));
	const y = (name: string) => TOP + (laneIndex.get(name) ?? 0) * LANE_H + LANE_H / 2;
	const mainName = overview.main.name;
	const laneOf = (m: Moment) => (m.lane === "main" ? mainName : m.lane);
	const curve = (xa: number, ya: number, xb: number, yb: number) => {
		const mid = (xa + xb) / 2;
		return `M${xa} ${ya}C${mid} ${ya} ${mid} ${yb} ${xb} ${yb}`;
	};
	// Day ticks at local midnights inside the window.
	const ticks: { x: number; label: string }[] = [];
	const first = new Date(start * 1000);
	first.setHours(24, 0, 0, 0);
	let lastX = -Infinity;
	for (let t = first.getTime() / 1000; t < nowSec; t += DAY) {
		const tx = x(t);
		if (tx - lastX >= 34 && x1 - tx >= 24) {
			ticks.push({ x: tx, label: dayLabel(t, days) });
			lastX = tx;
		}
	}
	const band = (since: number, laneName: string, label: string, key: string) => {
		const bx = x(Math.max(since, start));
		return (
			<g key={key} data-testid="swimlane-band">
				<rect x={bx} y={y(laneName) - 5} width={Math.max(2, x1 - bx)} height={10} rx={5} fill="#ffffff" fillOpacity={0.12} />
				<text x={bx} y={y(laneName) + 19} fontSize={10} fill="#9ca3af">{label}</text>
			</g>
		);
	};
	return (
		<svg data-testid="branch-graph" role="img" aria-label="Git swimlanes" width={width} height={height} className="font-mono" style={{ minWidth: width }}>
			<line x1={x1} x2={x1} y1={TOP - 6} y2={height - BOTTOM + 4} stroke="#9ca3af" strokeOpacity={0.5} strokeDasharray="3 3" />
			<text x={x1} y={TOP - 7} fontSize={10} textAnchor="middle" fill="#9ca3af">now</text>
			{lanes.map((l, i) => {
				const ly = TOP + i * LANE_H + LANE_H / 2;
				const color = COLORS[l.role];
				const sw = l.bold ? 3 : 1.5;
				const enters = l.forkAt === null || l.forkAt < start;
				const fx = enters ? x0 : x(l.forkAt!);
				return (
					<g key={l.name} data-testid="branch-graph-lane" data-kind={l.role}>
						<LaneLabel lane={l} y={ly} />
						{l.parent && !enters && (
							<>
								<circle cx={fx} cy={y(l.parent)} r={DOT} fill={color} />
								<path d={curve(fx, y(l.parent), fx + 18, ly)} fill="none" stroke={color} strokeWidth={sw} />
								<line x1={fx + 18} x2={x1} y1={ly} y2={ly} stroke={color} strokeWidth={sw} />
							</>
						)}
						{(!l.parent || enters) && <line x1={fx} x2={x1} y1={ly} y2={ly} stroke={color} strokeWidth={sw} />}
					</g>
				);
			})}
			{unreleasedSince !== null && overview.unreleased && band(unreleasedSince, overview.home, `unreleased · ${overview.unreleased.count} commits`, "unreleased")}
			{unmergedSince !== null && overview.unmerged && band(unmergedSince, mainName, `unmerged · ${overview.unmerged.count} commits`, "unmerged")}
			{moments.map((m, i) => {
				const mx = x(m.at);
				const my = y(laneOf(m));
				const tip = [m.label, m.workId, m.detail, new Date(m.at * 1000).toLocaleString()].filter(Boolean).join("\n");
				if (m.kind === "pr")
					return (
						<g key={i} data-testid="swimlane-pr">
							<path d={curve(mx - 16, y(overview.home), mx, my)} fill="none" stroke={BLUE} strokeWidth={1.5} />
							<rect x={mx - DOT} y={my - DOT} width={DOT * 2} height={DOT * 2} fill={BLUE} transform={`rotate(45 ${mx} ${my})`} />
							<text x={mx + 6} y={my + 17} fontSize={10} fill={BLUE}>{m.label}</text>
							<title>{tip}</title>
						</g>
					);
				if (m.kind === "release")
					return (
						<g key={i} data-testid="swimlane-release">
							<polygon points={`${mx},${my} ${mx},${my - 11} ${mx + 11},${my - 11} ${mx + 8},${my - 7} ${mx + 11},${my - 3} ${mx + 11},${my}`} fill={YELLOW} />
							<text x={mx + 13} y={my - 3} fontSize={10} fill={YELLOW}>{m.label}</text>
							<title>{tip}</title>
						</g>
					);
				if (m.kind === "landed")
					return (
						<g key={i} data-testid="swimlane-landed">
							<path d={`M${mx - 16} ${my}C${mx - 12} ${my - 12} ${mx - 4} ${my - 12} ${mx} ${my - DOT}`} fill="none" stroke="#9ca3af" strokeOpacity={0.6} />
							<circle cx={mx} cy={my} r={DOT} fill="var(--popover, #111)" stroke={YELLOW} strokeWidth={2} />
							<text x={mx - 16} y={my - 10} fontSize={10} fill="#d4b45a">{clip(m.label, 24)}</text>
							<title>{tip}</title>
						</g>
					);
				// split: the dot is drawn with its lane; this adds the tooltip target
				return (
					<circle key={i} data-testid="swimlane-split" cx={mx} cy={my} r={DOT + 2} fill="transparent">
						<title>{tip}</title>
					</circle>
				);
			})}
			{ticks.map((t) => (
				<g key={t.x}>
					<line x1={t.x} x2={t.x} y1={height - BOTTOM + 4} y2={height - BOTTOM + 8} stroke="#6b7280" />
					<text x={t.x} y={height - 3} fontSize={10} textAnchor="middle" fill="#6b7280">{t.label}</text>
				</g>
			))}
		</svg>
	);
}

const KIND_LABEL: Record<Moment["kind"], string> = { split: "split", pr: "PR merged", release: "release", landed: "landed" };

/** The large view's list of moments, newest first: time, kind, work item chip, title. */
export function MomentList({ overview, rings, days, nowSec }: { overview: GitOverview; rings: Moment[]; days: number; nowSec: number }) {
	const moments = buildMoments(overview, rings, nowSec, days).reverse();
	if (moments.length === 0) return <p className="text-muted-foreground">No moments in the last {days} days.</p>;
	return (
		<ul data-testid="git-moments" className="divide-y divide-border/50 font-mono text-[11px]">
			{moments.map((m, i) => (
				<li key={i} className="flex items-center gap-3 py-1">
					<span className="w-28 shrink-0 text-muted-foreground">{new Date(m.at * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
					<span className="w-20 shrink-0 text-muted-foreground">{KIND_LABEL[m.kind]}</span>
					{m.workId && <WorkIdChip id={m.workId} />}
					<span className="min-w-0 truncate">{m.label}</span>
				</li>
			))}
		</ul>
	);
}
