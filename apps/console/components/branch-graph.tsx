"use client";

import type { BranchGraph } from "@/src/core";

const STEP = 36;
const LANE_H = 30;
const LABEL_W = 190;
const R = 5;
const COLORS = ["#8b95a7", "#c78bfa", "#5eb0ff", "#4ade80", "#fbbf24", "#f472b6", "#2dd4bf"];

function truncate(name: string, max = 28): string {
	return name.length <= max ? name : `${name.slice(0, 10)}…${name.slice(name.length - (max - 11))}`;
}

/** Compact git-flow style lane diagram: one lane per branch (label at left), commits as circles, oldest → newest left → right. */
export function BranchGraphView({ graph }: { graph: BranchGraph }) {
	if (graph.lanes.length === 0 || graph.commits.length === 0) return null;
	const width = LABEL_W + graph.commits.length * STEP + 6;
	const height = graph.lanes.length * LANE_H;
	const x = (i: number) => LABEL_W + i * STEP + STEP / 2;
	const y = (lane: number) => lane * LANE_H + LANE_H / 2;
	const index = new Map(graph.commits.map((c, i) => [c.sha, i]));
	const color = (lane: number) => COLORS[lane % COLORS.length]!;
	return (
		<svg data-testid="branch-graph" role="img" aria-label="Branch graph" viewBox={`0 0 ${width} ${height}`} width="100%" className="font-mono">
			{graph.lanes.map((l, i) => (
				<g key={l.name} data-testid="branch-graph-lane" data-kind={l.kind}>
					<line x1={LABEL_W} x2={width} y1={y(i)} y2={y(i)} stroke={color(i)} strokeOpacity={0.15} />
					<text x={0} y={y(i) + 4} fontSize={11} fill={color(i)} className={l.kind === "feature" ? "font-semibold" : undefined}>
						<title>{l.name}</title>
						{truncate(l.name)}
					</text>
				</g>
			))}
			{graph.commits.flatMap((c, ci) =>
				c.parents.flatMap((p) => {
					const pi = index.get(p);
					if (pi === undefined) return [];
					const parent = graph.commits[pi]!;
					const [px, py, cx, cy] = [x(pi), y(parent.lane), x(ci), y(c.lane)];
					// A cross-lane edge is coloured by the lane it runs on at the newer end (fork) or older end (merge-back).
					const lane = parent.lane === c.lane ? c.lane : c.parents[0] === p ? c.lane : parent.lane;
					const mid = (px + cx) / 2;
					const d = py === cy ? `M${px} ${py}H${cx}` : `M${px} ${py}C${mid} ${py} ${mid} ${cy} ${cx} ${cy}`;
					return [<path key={`${c.sha}-${p}`} data-testid="branch-graph-edge" d={d} fill="none" stroke={color(lane)} strokeWidth={2} />];
				}),
			)}
			{graph.commits.map((c, i) => (
				<circle key={c.sha} data-testid="branch-graph-node" cx={x(i)} cy={y(c.lane)} r={R} fill={color(c.lane)} stroke="var(--popover, #111)" strokeWidth={1}>
					<title>{`${c.sha.slice(0, 7)} ${c.subject}`}</title>
				</circle>
			))}
		</svg>
	);
}
