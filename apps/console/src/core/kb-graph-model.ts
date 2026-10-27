/**
 * THE KB GRAPH MODEL — pure mapping from the librarian's KbGraph payload to
 * what the canvas draws, plus the per-node card model. No DOM, no IO.
 *
 *   - domainHue: stable domain colour (pinned palette slots for the known
 *     domains, a hash-derived hue for new ones, an override from the
 *     payload's domains[].color).
 *   - nodeStyle: kind → size / disc-or-ring / dimming / label gate; work
 *     items are hollow rings whose outline weight follows the stage.
 *   - groupClusters: the region glow groups, by domain or by section.
 *   - depthOf: hierarchy depth for the optional depth anchoring.
 *   - toCanvasData: everything above folded into the renderer's data shape
 *     (positions are the view's job — this module never lays anything out).
 *   - isNodeVisible / visibleNodeIds: the search filter.
 *   - describeNode: the detail card's content, per node kind.
 *   - parseFocusParam: the `/?focus=<nodeId>` URL contract.
 */

import { entryHref, workHref } from "./kb.ts";
import type { KbGraph, KbGraphNode, KbNodeKind } from "./kb.ts";
import { NODE_ID_PATTERN } from "./graph-persistence.ts";
import type { GraphLayerToggles, GroupBy } from "./render-settings.ts";

/** One entry of the payload's `domains` list. */
export type KbGraphDomain = KbGraph["domains"][number];

// ─── Domain colour ──────────────────────────────────────────────────────────

/** The curated palette (mid-light, readable on the dark stage). */
export const DOMAIN_PALETTE: readonly string[] = [
	"#6ea8fe", "#f59e6c", "#7bd88f", "#c792ea", "#f2cc60",
	"#4fd1c5", "#ff7a90", "#a3b8ef", "#e0a96d", "#8bd3dd",
	"#d4a5e8", "#b5d96b", "#f08fc0", "#7fb7a4", "#e6b17e",
	"#9aa5f7", "#d9e07a", "#5fc7e8", "#ef8f7a", "#a6d189",
];

/** Domains that own a fixed palette slot, so their colour never depends on
 *  what else exists. Everything else takes a hash-derived hue. */
export const PINNED_DOMAIN_SLOTS: Readonly<Record<string, number>> = { wolfpack: 0, snapjack: 1, personal: 2 };

/** Colour of nodes that belong to no domain (den topics without one). */
export const NEUTRAL_NODE_COLOR = "#8a8f98";

/** FNV-1a — a stable string hash (same input, same output, any session). */
export function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** "#rgb" / "#rrggbb" → lowercase "#rrggbb"; anything else → null. */
export function normalizeHex(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (/^#[0-9a-f]{6}$/.test(v)) return v;
	const m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
	return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : null;
}

/** HSL (h 0–360, s/l 0–1) → "#rrggbb". */
export function hslToHex(h: number, s: number, l: number): string {
	const k = (n: number) => (n + h / 30) % 12;
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return `#${[f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

/** A domain's colour: the owner's override (domains.yaml `color`, a valid
 *  hex) wins; then its pinned palette slot; then a stable hash-derived hue. */
export function domainHue(name: string, override?: string | null): string {
	const fixed = normalizeHex(override);
	if (fixed) return fixed;
	const slot = PINNED_DOMAIN_SLOTS[name];
	if (slot !== undefined) return DOMAIN_PALETTE[slot % DOMAIN_PALETTE.length]!;
	return hslToHex(hashString(name) % 360, 0.6, 0.66);
}

/** name → colour for every domain the payload knows (plus any domain a node
 *  names that the list omitted). */
export function domainColors(graph: Pick<KbGraph, "domains" | "nodes">): Map<string, string> {
	const out = new Map<string, string>();
	for (const d of graph.domains) out.set(d.name, domainHue(d.name, d.color));
	for (const n of graph.nodes) if (n.domain && !out.has(n.domain)) out.set(n.domain, domainHue(n.domain));
	return out;
}

// ─── Node style ─────────────────────────────────────────────────────────────

export type NodeShape = "disc" | "ring";

/** How the renderer draws one node (the renderer learns ring + dim, no new
 *  shapes). */
export interface NodeStyle {
	/** Radius multiplier over the nodeSize setting. */
	radius: number;
	shape: NodeShape;
	/** Ring outline weight as a fraction of the radius (0 for discs). */
	ring: number;
	/** Drawn faded. */
	dim: boolean;
	/** Multiplier on the labelZoom gate: 1 = the global gate, below 1 = the
	 *  label appears only after zooming further in. */
	labelGate: number;
}

/** Work outline weight by stage: heavier as the item progresses. */
export const WORK_RING_WEIGHT: Readonly<Record<string, number>> = {
	idea: 0.15,
	plan: 0.2,
	feasibility: 0.25,
	approved: 0.3,
	in_build: 0.4,
	shipped: 0.5,
	live: 0.6,
	archived: 0.15,
};
const DEFAULT_RING_WEIGHT = 0.25;

/** Kind (and, for work, stage) → draw style. */
export function nodeStyle(node: Pick<KbGraphNode, "kind" | "stage">): NodeStyle {
	switch (node.kind) {
		case "domain":
			return { radius: 3.2, shape: "disc", ring: 0, dim: false, labelGate: 0.5 };
		case "section":
			return { radius: 1.9, shape: "disc", ring: 0, dim: false, labelGate: 0.8 };
		case "work":
			return {
				radius: 1.15,
				shape: "ring",
				ring: WORK_RING_WEIGHT[node.stage ?? ""] ?? DEFAULT_RING_WEIGHT,
				dim: node.stage === "archived",
				labelGate: 1,
			};
		case "den-topic":
			return { radius: 0.6, shape: "disc", ring: 0, dim: true, labelGate: 0.7 };
		default:
			return { radius: 1, shape: "disc", ring: 0, dim: false, labelGate: 1 };
	}
}

/** The node's fill colour: its domain's hue (matches the region glow). */
export function nodeColor(node: Pick<KbGraphNode, "domain">, colors: ReadonlyMap<string, string>): string {
	return (node.domain && colors.get(node.domain)) || NEUTRAL_NODE_COLOR;
}

// ─── Depth ──────────────────────────────────────────────────────────────────

const KIND_DEPTH: Record<KbNodeKind, number> = { domain: 0, section: 1, entry: 2, work: 3, "den-topic": 4 };

/** Hierarchy depth (domain 0 → section 1 → entry 2 → work 3 → den topic 4):
 *  the payload's own depth when sane, else the kind's. */
export function depthOf(node: Pick<KbGraphNode, "kind" | "depth">): number {
	const d = node.depth;
	if (typeof d === "number" && Number.isFinite(d) && d >= 0) return Math.min(Math.round(d), 4);
	return KIND_DEPTH[node.kind] ?? 2;
}

// ─── Clusters (the region glow) ─────────────────────────────────────────────

export interface KbCluster {
	id: string;
	label: string | null;
	/** "#rrggbb" — the domain's hue (the neutral grey for den clusters). */
	color: string;
	members: string[];
}

/**
 * The glow groups. "domain": one per domain (its node, sections, entries and
 * work), plus one per wolf for den topics. "section": one per section (the
 * section node + its entries); the domain node, work and section-less entries
 * stay in their domain's group. Groups under two members are dropped (a
 * region needs a neighbour). Sorted by id — deterministic.
 */
export function groupClusters(
	graph: Pick<KbGraph, "nodes" | "domains">,
	groupBy: GroupBy,
	colors: ReadonlyMap<string, string> = domainColors(graph),
): KbCluster[] {
	const domainLabels = new Map(graph.domains.map((d) => [d.name, d.label]));
	const sectionById = new Map(graph.nodes.filter((n) => n.kind === "section").map((n) => [n.id, n]));
	const groups = new Map<string, KbCluster>();
	const add = (id: string, label: string | null, color: string, member: string): void => {
		let g = groups.get(id);
		if (!g) groups.set(id, (g = { id, label, color, members: [] }));
		g.members.push(member);
	};
	for (const n of graph.nodes) {
		if (n.kind === "den-topic") {
			if (n.wolf) add(`den:${n.wolf}`, `${n.wolf} den`, NEUTRAL_NODE_COLOR, n.id);
			continue;
		}
		if (!n.domain) continue;
		const color = colors.get(n.domain) ?? NEUTRAL_NODE_COLOR;
		const domainGroup = () => add(`dom:${n.domain}`, domainLabels.get(n.domain!) ?? n.domain!, color, n.id);
		if (groupBy === "section") {
			if (n.kind === "section") {
				add(n.id, n.label, color, n.id);
				continue;
			}
			const sid = n.kind === "entry" && n.sectionId ? `sec:${n.sectionId}` : null;
			const sec = sid ? sectionById.get(sid) : undefined;
			if (sid && sec) {
				add(sid, sec.label, color, n.id);
				continue;
			}
		}
		domainGroup();
	}
	return [...groups.values()]
		.filter((g) => g.members.length >= 2)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ─── Canvas data ────────────────────────────────────────────────────────────

/** One node as the renderer draws it (position added by the view). */
export interface KbCanvasNode extends NodeStyle {
	id: string;
	label: string;
	color: string;
}

export interface KbCanvasEdge {
	from: string;
	to: string;
	/** Drawn lighter (related / wikilink — soft associations, not structure). */
	faint: boolean;
}

export interface KbCanvasData {
	nodes: KbCanvasNode[];
	edges: KbCanvasEdge[];
	clusters: KbCluster[];
	/** Hierarchy depth per node id (for the depth anchoring). */
	depths: Map<string, number>;
}

/** The payload → canvas data. Edges to missing endpoints and duplicates are
 *  dropped; edge direction is irrelevant on the canvas (no arrowheads). */
export function toCanvasData(graph: KbGraph, opts: { groupBy: GroupBy }): KbCanvasData {
	const colors = domainColors(graph);
	const ids = new Set<string>();
	const nodes: KbCanvasNode[] = [];
	const depths = new Map<string, number>();
	for (const n of graph.nodes) {
		if (ids.has(n.id)) continue;
		ids.add(n.id);
		nodes.push({ id: n.id, label: n.label, color: nodeColor(n, colors), ...nodeStyle(n) });
		depths.set(n.id, depthOf(n));
	}
	const seen = new Set<string>();
	const edges: KbCanvasEdge[] = [];
	for (const e of graph.edges) {
		if (e.source === e.target || !ids.has(e.source) || !ids.has(e.target)) continue;
		const key = `${e.source}\u0000${e.target}\u0000${e.kind}`;
		if (seen.has(key)) continue;
		seen.add(key);
		edges.push({ from: e.source, to: e.target, faint: e.kind === "related" || e.kind === "wikilink" });
	}
	return { nodes, edges, clusters: groupClusters(graph, opts.groupBy, colors), depths };
}

// ─── Search ─────────────────────────────────────────────────────────────────

/** A node matches when the query (case-insensitive, trimmed) is empty or is
 *  contained in its label, id, summary, domain, stage or entry kind. */
export function isNodeVisible(
	node: Pick<KbGraphNode, "id" | "label" | "summary" | "domain" | "stage" | "entryKind">,
	query: string,
): boolean {
	const q = query.trim().toLowerCase();
	if (!q) return true;
	return [node.label, node.id, node.summary, node.domain, node.stage, node.entryKind].some(
		(f) => typeof f === "string" && f.toLowerCase().includes(q),
	);
}

export function visibleNodeIds(nodes: readonly KbGraphNode[], query: string): Set<string> {
	const out = new Set<string>();
	for (const n of nodes) if (isNodeVisible(n, query)) out.add(n.id);
	return out;
}

// ─── Detail cards ───────────────────────────────────────────────────────────

export interface CardLink {
	id: string;
	label: string;
	kind: KbNodeKind;
	/** `related` edges: the relation kind (see_also, refines, ...). */
	relation?: string;
}

export interface NodeCard {
	id: string;
	kind: KbNodeKind;
	title: string;
	summary?: string;
	domain?: { name: string; label: string };
	/** Entry: the section it sits in. */
	section?: { id: string; label: string };
	maturity?: string;
	entryKind?: string;
	stage?: string;
	workKind?: string;
	assignee?: string;
	wolf?: string;
	promotable?: boolean;
	updated?: string;
	/** Entry: `related` edges, either direction. */
	related: CardLink[];
	/** Work: the item it is part of. */
	parent: CardLink | null;
	/** Work: the items it depends on. */
	dependencies: CardLink[];
	/** Domain: counts of what it contains, by kind. */
	counts?: Partial<Record<KbNodeKind, number>>;
	/** "open" target: the entry reader or the work item page. */
	openHref?: string;
	/** Section: the node ids to focus the graph on (itself, its entries and
	 *  subsections). */
	focusIds?: string[];
}

/** The entry / work id inside a node id (`ent:<id>` → `<id>`), or null when
 *  the node is not of that kind. */
export function entryIdOfNode(nodeId: string): string | null {
	return nodeId.startsWith("ent:") && nodeId.length > 4 ? nodeId.slice(4) : null;
}
export function workIdOfNode(nodeId: string): string | null {
	return nodeId.startsWith("work:") && nodeId.length > 5 ? nodeId.slice(5) : null;
}

/** The card for one node, or null for an unknown id. */
export function describeNode(graph: KbGraph, nodeId: string): NodeCard | null {
	const byId = new Map(graph.nodes.map((n) => [n.id, n]));
	const node = byId.get(nodeId);
	if (!node) return null;
	const link = (id: string, relation?: string): CardLink | null => {
		const n = byId.get(id);
		return n ? { id, label: n.label, kind: n.kind, ...(relation ? { relation } : {}) } : null;
	};
	const card: NodeCard = { id: node.id, kind: node.kind, title: node.label, related: [], parent: null, dependencies: [] };
	if (node.summary) card.summary = node.summary;
	if (node.domain) {
		const d = graph.domains.find((x) => x.name === node.domain);
		card.domain = { name: node.domain, label: d?.label ?? node.domain };
	}
	if (node.updated) card.updated = node.updated;

	if (node.kind === "entry") {
		if (node.maturity) card.maturity = node.maturity;
		if (node.entryKind) card.entryKind = node.entryKind;
		if (node.sectionId) {
			const sec = byId.get(`sec:${node.sectionId}`);
			if (sec) card.section = { id: sec.id, label: sec.label };
		}
		const seen = new Set<string>();
		for (const e of graph.edges) {
			if (e.kind !== "related") continue;
			const other = e.source === node.id ? e.target : e.target === node.id ? e.source : null;
			if (!other || other === node.id || seen.has(other)) continue;
			const l = link(other, e.relation);
			if (l) {
				seen.add(other);
				card.related.push(l);
			}
		}
		const id = entryIdOfNode(node.id);
		if (id) card.openHref = entryHref(id);
	} else if (node.kind === "work") {
		if (node.stage) card.stage = node.stage;
		if (node.workKind) card.workKind = node.workKind;
		if (node.assignee) card.assignee = node.assignee;
		for (const e of graph.edges) {
			if (e.source !== node.id) continue;
			if (e.kind === "partOf" && !card.parent) card.parent = link(e.target);
			else if (e.kind === "dependsOn") {
				const l = link(e.target);
				if (l) card.dependencies.push(l);
			}
		}
		const id = workIdOfNode(node.id);
		if (id) card.openHref = workHref(id);
	} else if (node.kind === "section") {
		const focus = new Set<string>([node.id]);
		const sid = node.sectionId;
		for (const n of graph.nodes) if (n.kind === "entry" && sid && n.sectionId === sid) focus.add(n.id);
		// Subsections (hierarchy section → section), transitively.
		const queue = [node.id];
		while (queue.length > 0) {
			const cur = queue.pop()!;
			for (const e of graph.edges) {
				if (e.kind !== "hierarchy" || e.source !== cur || focus.has(e.target)) continue;
				const t = byId.get(e.target);
				if (t?.kind !== "section") continue;
				focus.add(t.id);
				queue.push(t.id);
				for (const n of graph.nodes) if (n.kind === "entry" && n.sectionId === t.sectionId) focus.add(n.id);
			}
		}
		card.focusIds = [...focus];
	} else if (node.kind === "den-topic") {
		if (node.wolf) card.wolf = node.wolf;
		if (node.promotable !== undefined) card.promotable = node.promotable;
	} else if (node.kind === "domain") {
		const counts: Partial<Record<KbNodeKind, number>> = {};
		for (const n of graph.nodes) {
			if (n.domain !== node.domain || n.id === node.id) continue;
			counts[n.kind] = (counts[n.kind] ?? 0) + 1;
		}
		card.counts = counts;
	}
	return card;
}

// ─── Focus param ────────────────────────────────────────────────────────────

const MAX_NODE_ID = 512;

/** The `focus` query parameter of `/?focus=<nodeId>`: a well-formed graph
 *  node id, or null. Accepts a raw search string or anything with `get`. */
export function parseFocusParam(search: string | { get(name: string): string | null } | null | undefined): string | null {
	if (search == null) return null;
	const raw = typeof search === "string" ? new URLSearchParams(search).get("focus") : search.get("focus");
	if (raw == null) return null;
	const id = raw.trim();
	return id.length <= MAX_NODE_ID && NODE_ID_PATTERN.test(id) ? id : null;
}

/** What a `/?focus=` target needs that the current view lacks. */
export interface FocusRemedy {
	archivedWork?: true;
	denTopics?: true;
	/** Ignore the domain filter. */
	allDomains?: true;
}

/** When a focus target is not in the loaded graph: the (transient) view
 *  changes that could bring it in — archived work for `work:` ids, den
 *  topics for `den:` ids, no domain filter — or null when nothing would
 *  help. */
export function focusRemedy(nodeId: string, view: { layers: GraphLayerToggles; domain: string | null }): FocusRemedy | null {
	const r: FocusRemedy = {};
	if (nodeId.startsWith("work:") && !view.layers.archivedWork) r.archivedWork = true;
	if (nodeId.startsWith("den:") && !view.layers.denTopics) r.denTopics = true;
	if (view.domain !== null) r.allDomains = true;
	return Object.keys(r).length > 0 ? r : null;
}

/** One step of the `/?focus=` flow. `settled` = the graph in hand was
 *  fetched with the CURRENT query (not a previous one still on screen). */
export type FocusStep =
	| { kind: "idle" }
	| { kind: "wait" }
	| { kind: "focus" }
	| { kind: "widen"; remedy: FocusRemedy }
	| { kind: "missing" };

export function focusStep(input: {
	focusId: string | null;
	graph: Pick<KbGraph, "nodes"> | null;
	settled: boolean;
	view: { layers: GraphLayerToggles; domain: string | null };
}): FocusStep {
	if (!input.focusId) return { kind: "idle" };
	if (!input.graph || !input.settled) return { kind: "wait" };
	if (input.graph.nodes.some((n) => n.id === input.focusId)) return { kind: "focus" };
	const remedy = focusRemedy(input.focusId, input.view);
	return remedy ? { kind: "widen", remedy } : { kind: "missing" };
}
