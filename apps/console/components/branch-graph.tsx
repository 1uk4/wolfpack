"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { WorkIdChip, lookupWorkItem } from "@/components/work-id-chip";
import { agentName, branchShortId, buildMoments, candidateWorkIds, collapseRows, featureOfItem, landedMoments, mergeNear, middleClip, placeBandLabel, placeLabels, preferredDomain, shipMoments, swimLanes, timeScale, type GitOverview, type Moment, type ShipSubject, type SwimLane } from "@/src/core";

const LANE_H = 22;
/** Lane-label column widths: the card, and the large view. */
export const CARD_LABEL_W = 150;
export const LARGE_LABEL_W = 200;
/** The card's whole SVG is fitted to about this width (the axis is compressed, never stretched). */
export const CARD_FIT_W = 600;
const CHAR_PX = 6.6;
const FLAG_GAP = 40;
const RING_GAP = 12;
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
function useBranchTitle(shortId: string | null, domain?: string): string | undefined {
	const [title, setTitle] = useState<string>();
	useEffect(() => {
		if (!shortId) return;
		let live = true;
		void (async () => {
			for (const id of candidateWorkIds(shortId, domain)) {
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
	}, [shortId, domain]);
	return title;
}

/** A lane's label: the agent name for a subagent, the work item title for a feature, else the branch name. The full text is the tooltip. */
function LaneLabel({ lane, y, labelW, domain }: { lane: SwimLane; y: number; labelW: number; domain?: string }) {
	const subagent = lane.role === "child";
	const title = useBranchTitle(!subagent && (lane.role === "main" || lane.role === "sibling" || lane.role === "feature") ? branchShortId(lane.name) : null, domain);
	const max = Math.max(8, Math.floor((labelW - PAD_L - 6) / CHAR_PX));
	const text = subagent ? clip(agentName(lane.name), max) : title ? clip(title, max) : middleClip(lane.name, max);
	return (
		<text x={PAD_L} y={y + 4} fontSize={11} fill={COLORS[lane.role]} fontWeight={lane.bold ? 600 : 400}>
			<title>{title ? `${title}\n${lane.name}` : lane.name}</title>
			{text}
		</text>
	);
}

/** A scroll box that opens at its right end ("now") and returns there when `watch` changes. */
export function ScrollEnd({ watch, className, children, onClick }: { watch: string; className?: string; children: ReactNode; onClick?: () => void }) {
	const ref = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const el = ref.current;
		if (el) el.scrollLeft = el.scrollWidth;
	}, [watch]);
	return (
		<div ref={ref} className={className} onClick={onClick} data-testid="swimlane-scroll">
			{children}
		</div>
	);
}

/** The large view's graph: its 30-day axis is fitted to the measured container width, so "now" sits at the right edge. */
export function FitSwimlanes({ overview, rings, days, nowSec }: { overview: GitOverview; rings: Moment[]; days: number; nowSec: number }) {
	const ref = useRef<HTMLDivElement>(null);
	const [w, setW] = useState(0);
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		setW(el.clientWidth);
		if (typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver(() => setW(el.clientWidth));
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	return (
		<div ref={ref} className="w-full">
			{w > 0 && <Swimlanes overview={overview} rings={rings} days={days} nowSec={nowSec} labelW={LARGE_LABEL_W} fitWidth={w} grow />}
		</div>
	);
}

/**
 * The landed rings. A landing's time is exact: the parent branch's reflog records every fast-forward to the second, and
 * the commits it brought name the work items. Only landings the reflog lacks (older than it, or a clone without it)
 * fall back to the work item's ship date, which is day-only. Lookups are the chips' cached ones; empty until they resolve.
 */
export function useRings(overview: GitOverview | undefined, nowSec: number): Moment[] {
	const [rings, setRings] = useState<Moment[]>([]);
	const feature = overview?.main.kind === "feature" ? branchShortId(overview.main.name) : null;
	const landingIds = overview ? overview.landings.flatMap((l) => l.workIds) : [];
	const ids = overview ? [...new Set([...landingIds, ...overview.history.map((r) => r.workId).filter((x): x is string => x !== null)])].slice(0, MAX_LOOKUPS) : [];
	const shorts = overview ? [...overview.branches, ...overview.siblings].filter((b) => b.landed && b.shortId).map((b) => b.shortId!) : [];
	const active = overview ? [...overview.branches, ...overview.siblings].filter((b) => !b.landed && b.shortId).map((b) => b.shortId!) : [];
	const key = [overview?.main.name ?? "", ...ids, "|", ...shorts, "|", ...active, "|", ...(overview?.landings.map((l) => l.at) ?? [])].join(",");
	useEffect(() => {
		if (!overview) return;
		let live = true;
		void (async () => {
			const items: Record<string, ShipSubject> = {};
			const take = (key: string, v: Awaited<ReturnType<typeof lookupWorkItem>>) => {
				if (v.kind !== "ok") return;
				// A feature thread names child tasks; home names the feature the item belongs to (itself, or its parent).
				const rec = feature ? v.item : featureOfItem(v.item, v.parent) === null ? null : v.item.kind === "feature" ? v.item : v.parent;
				if (rec) items[key] = { id: rec.id, title: rec.title, kind: rec.kind, stage: rec.stage, updated: rec.updated, partOf: rec.partOf ?? null };
			};
			for (const id of ids) take(id, await lookupWorkItem(id));
			for (const short of shorts) {
				for (const id of candidateWorkIds(short, domainOf(overview))) {
					const v = await lookupWorkItem(id);
					if (v.kind === "ok") {
						take(id, v);
						break;
					}
				}
			}
			const exact = landedMoments(overview.landings, items, { feature, activeShortIds: active });
			const covered = exact.flatMap((m) => m.workIds ?? []);
			const fallback = shipMoments(Object.values(items), { feature, nowSec, activeShortIds: active, covered });
			if (live) setRings([...exact, ...fallback].sort((a, b) => a.at - b.at));
		})();
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [key]);
	return rings;
}

/** The work domain of the thread's own items (from the work IDs its commits and landings name), asked first on lookups. */
const domainOf = (o: GitOverview): string | undefined => preferredDomain([...o.landings.flatMap((l) => l.workIds), ...o.history.map((r) => r.workId).filter((x): x is string => x !== null)]);

const dayLabel = (t: number, days: number): string => {
	const d = new Date(t * 1000);
	return days <= 7 ? d.toLocaleDateString(undefined, { weekday: "short" }) : `${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * Time swimlanes of significant moments, left to right, "now" at the right edge. Fixed pixel sizes (11px text, 22px
 * lanes): the card never scales with its width. Quiet stretches are squeezed so busy days get the room.
 */
export function Swimlanes({ overview, rings, days, nowSec, labelW = CARD_LABEL_W, fitWidth, grow = false }: { overview: GitOverview; rings: Moment[]; days: number; nowSec: number; labelW?: number; fitWidth?: number; grow?: boolean }) {
	const lanes = swimLanes(overview);
	const start = nowSec - days * DAY;
	const raw = buildMoments(overview, rings, nowSec, days);
	const sinceOf = (s: { count: number; since: number | null } | null) => (s && s.count > 0 && s.since !== null ? s.since : null);
	const unreleasedSince = sinceOf(overview.unreleased);
	const unmergedSince = overview.main.kind === "feature" ? sinceOf(overview.unmerged) : null;
	const times = [...raw.map((m) => m.at), ...[unreleasedSince, unmergedSince].filter((t): t is number => t !== null && t > start)];
	const scale = timeScale(times, start, nowSec, fitWidth ? { width: Math.max(80, fitWidth - labelW - PAD_R), grow } : undefined);
	const x0 = labelW;
	const x = (t: number) => x0 + scale.x(t);
	const x1 = x(nowSec);
	const width = x1 + PAD_R;
	const height = TOP + lanes.length * LANE_H + BOTTOM;
	// Flags closer than ~40px become one flag (+N), rings closer than ~12px one ring (the count in its tooltip).
	const moments = mergeNear(mergeNear(raw, "release", (t) => x(t), FLAG_GAP), "landed", (t) => x(t), RING_GAP);
	const laneIndex = new Map(lanes.map((l, i) => [l.name, i]));
	const y = (name: string) => TOP + (laneIndex.get(name) ?? 0) * LANE_H + LANE_H / 2;
	const mainName = overview.main.name;
	const laneOf = (m: Moment) => (m.lane === "main" ? mainName : m.lane === "home" ? overview.home : m.lane);
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
	// Labels never draw over each other: within one band between lanes, the later of two overlapping labels is dropped
	// (the marker and its tooltip stay). A region is the space below a lane, which is also the space above the next.
	const CHAR_W = 6;
	const regionOf = (name: string, side: "above" | "below") => `r${(laneIndex.get(name) ?? 0) + (side === "below" ? 0 : -1)}`;
	const labelSpec = (m: Moment, i: number) => {
		const mx = x(m.at);
		const text = m.kind === "landed" ? clip(m.label, 24) : m.label;
		const left = m.kind === "pr" ? mx + 6 : m.kind === "release" ? mx + 13 : mx - 16;
		const side = m.kind === "pr" ? "below" : "above";
		return { i, key: regionOf(laneOf(m), side), x: left, w: text.length * CHAR_W };
	};
	const labelled = moments.map((m, i) => ({ m, i })).filter(({ m }) => m.kind !== "split" && m.label !== "").map(({ m, i }) => labelSpec(m, i));
	const okLabels = placeLabels(labelled);
	const kept = new Set(labelled.flatMap((l, k) => (okLabels[k] ? [l.i] : [])));
	const taken = labelled.filter((_, k) => okLabels[k]);
	const bandOf = (since: number, laneName: string, label: string, key: string) => {
		const bx = x(Math.max(since, start));
		const w = label.length * CHAR_W;
		const lx = placeBandLabel({ key: regionOf(laneName, "below"), left: bx, right: x1, w }, taken);
		return (
			<g key={key} data-testid="swimlane-band">
				<rect x={bx} y={y(laneName) - 5} width={Math.max(2, x1 - bx)} height={10} rx={5} fill="#ffffff" fillOpacity={0.12}>
					<title>{label}</title>
				</rect>
				{lx !== null && <text x={lx} y={y(laneName) + 19} fontSize={10} fill="#9ca3af">{label}</text>}
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
						<LaneLabel lane={l} y={ly} labelW={labelW} domain={domainOf(overview)} />
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
			{unreleasedSince !== null && overview.unreleased && bandOf(unreleasedSince, overview.home, `unreleased · ${overview.unreleased.count} commits`, "unreleased")}
			{unmergedSince !== null && overview.unmerged && bandOf(unmergedSince, mainName, `unmerged · ${overview.unmerged.count} commits`, "unmerged")}
			{moments.map((m, i) => {
				const mx = x(m.at);
				const my = y(laneOf(m));
				const tip = [m.label, m.workId, m.detail, new Date(m.at * 1000).toLocaleString()].filter(Boolean).join("\n");
				if (m.kind === "pr")
					return (
						<g key={i} data-testid="swimlane-pr">
							<path d={curve(mx - 16, y(overview.home), mx, my)} fill="none" stroke={BLUE} strokeWidth={1.5} />
							<rect x={mx - DOT} y={my - DOT} width={DOT * 2} height={DOT * 2} fill={BLUE} transform={`rotate(45 ${mx} ${my})`} />
							{kept.has(i) && <text x={mx + 6} y={my + 17} fontSize={10} fill={BLUE}>{m.label}</text>}
							<title>{tip}</title>
						</g>
					);
				if (m.kind === "release")
					return (
						<g key={i} data-testid="swimlane-release">
							<polygon points={`${mx},${my} ${mx},${my - 11} ${mx + 11},${my - 11} ${mx + 8},${my - 7} ${mx + 11},${my - 3} ${mx + 11},${my}`} fill={YELLOW} />
							{kept.has(i) && <text x={mx + 13} y={my - 3} fontSize={10} fill={YELLOW}>{m.label}</text>}
							<title>{tip}</title>
						</g>
					);
				if (m.kind === "landed")
					return (
						<g key={i} data-testid="swimlane-landed">
							<path d={`M${mx - 16} ${my}C${mx - 12} ${my - 12} ${mx - 4} ${my - 12} ${mx} ${my - DOT}`} fill="none" stroke="#9ca3af" strokeOpacity={0.6} />
							<circle cx={mx} cy={my} r={DOT} fill="var(--popover, #111)" stroke={YELLOW} strokeWidth={2} />
							{kept.has(i) && <text x={mx - 16} y={my - 10} fontSize={10} fill="#d4b45a">{clip(m.label, 24)}</text>}
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
			{collapseRows(moments).map(({ moment: m, count }, i) => (
				<li key={i} className="flex items-center gap-3 py-1">
					<span className="w-28 shrink-0 text-muted-foreground">{new Date(m.at * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
					<span className="w-20 shrink-0 text-muted-foreground">{KIND_LABEL[m.kind]}</span>
					{m.workId && <WorkIdChip id={m.workId} />}
					<span className="min-w-0 truncate" title={m.detail}>{m.title ?? m.label}</span>
					{count > 1 && <span className="shrink-0 text-muted-foreground">×{count}</span>}
				</li>
			))}
		</ul>
	);
}
