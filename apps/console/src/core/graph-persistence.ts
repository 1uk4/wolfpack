/**
 * Graph persistence — the pure side: what the console remembers about the
 * KB graph in its OWN stores (the KB is never written).
 *
 *   - positions: nodeId → {x, y}, a plain JSON map in the data dir
 *     (server-side, behind /api/graph/positions). Keyed by the KB graph's
 *     node ids, so a layout survives refetches, layer toggles and restarts.
 *   - camera: {k, x, y} in localStorage (per-device view state).
 *
 * This module only validates, merges and seeds; reading/writing bytes is
 * src/server/graph-positions.ts and graph-view.tsx.
 */

import type { Position } from "./contracts.ts";
import { incrementalLayout } from "./layout.ts";

/** Max |x| or |y| accepted — NaN/Infinity are rejected, absurd values clamp. */
export const MAX_COORD = 1e6;
/** Upper bound on remembered nodes (a runaway client can't grow the file). */
export const MAX_STORED_POSITIONS = 20000;
const MAX_ID_LENGTH = 512;

/** localStorage key of the persisted camera (the renderer's d3 transform). */
export const GRAPH_CAMERA_KEY = "lh.graph.camera.v1";

export type PositionMap = Record<string, Position>;

/** The KB graph's node id shape: `dom:` / `sec:` / `ent:` / `work:` / `den:`
 *  prefixed. Nothing in this namespace can alias a prototype key. */
export const NODE_ID_PATTERN = /^(dom|sec|ent|work|den):.+/;

function isStorableId(id: string): boolean {
	return id.length <= MAX_ID_LENGTH && NODE_ID_PATTERN.test(id);
}

/**
 * Whatever came off disk or the network → a clean position map: string ids in
 * the KB namespace, finite coordinates (clamped to ±MAX_COORD), nothing else.
 * Tolerates the `{ positions: {...} }` envelope. Never throws.
 */
export function sanitizePositions(input: unknown): PositionMap {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
	let raw = input as Record<string, unknown>;
	const inner = raw.positions;
	if (typeof inner === "object" && inner !== null && !Array.isArray(inner)) raw = inner as Record<string, unknown>;
	const out: PositionMap = Object.create(null) as PositionMap;
	let count = 0;
	for (const [id, value] of Object.entries(raw)) {
		if (!isStorableId(id) || typeof value !== "object" || value === null) continue;
		const { x, y } = value as Record<string, unknown>;
		if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y)) continue;
		out[id] = { x: Math.min(Math.max(x, -MAX_COORD), MAX_COORD), y: Math.min(Math.max(y, -MAX_COORD), MAX_COORD) };
		if (++count >= MAX_STORED_POSITIONS) break;
	}
	return { ...out };
}

/**
 * Fold a committed batch into the stored map: incoming positions replace the
 * stored ones per id; ids the batch doesn't mention are KEPT (they belong to
 * layers or domains that are currently hidden). When the merged map would
 * exceed the cap, the oldest stored ids (insertion order) are dropped first.
 */
export function mergePositions(stored: PositionMap, incoming: PositionMap, max = MAX_STORED_POSITIONS): PositionMap {
	const merged = new Map<string, Position>(Object.entries(stored));
	for (const [id, p] of Object.entries(incoming)) {
		merged.delete(id); // re-insert last so recently committed ids are the newest
		merged.set(id, p);
	}
	while (merged.size > max) merged.delete(merged.keys().next().value as string);
	return Object.fromEntries(merged);
}

/**
 * Positions for the nodes on screen. Known positions (live or stored) are
 * kept EXACTLY; nodes with none are laid out by the same d3-force engine
 * the live physics runs, warm-started from the known ones (new nodes seed
 * beside their positioned neighbours, the rest on the rim). `added` lists
 * the freshly placed ids — the caller commits them so the layout is
 * remembered. Deterministic for a given input.
 */
export function resolvePositions(
	nodes: readonly { id: string }[],
	edges: readonly { from: string; to: string }[],
	known: ReadonlyMap<string, Position>,
	opts: {
		clusters?: ReadonlyArray<{ members: ReadonlyArray<string> }>;
		depSprings?: { edges: ReadonlyArray<{ from: string; to: string }> };
		linkLengths?: ReadonlyMap<string, number>;
	} = {},
): { positions: Map<string, Position>; added: string[] } {
	const positions = new Map<string, Position>();
	const missing: string[] = [];
	for (const n of nodes) {
		const p = known.get(n.id);
		if (p) positions.set(n.id, { x: p.x, y: p.y });
		else missing.push(n.id);
	}
	if (missing.length === 0) return { positions, added: [] };
	const laid = incrementalLayout(nodes, edges, new Map(positions), { clusters: opts.clusters, depSprings: opts.depSprings, linkLengths: opts.linkLengths });
	for (const id of missing) positions.set(id, laid.get(id) ?? { x: 0, y: 0 });
	return { positions, added: missing };
}

export interface Camera {
	k: number;
	x: number;
	y: number;
}

/** A stored camera (JSON text or parsed) → a valid camera, else null. */
export function parseCamera(raw: unknown): Camera | null {
	let v = raw;
	if (typeof raw === "string") {
		try {
			v = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (typeof v !== "object" || v === null) return null;
	const { k, x, y } = v as Record<string, unknown>;
	if (typeof k !== "number" || !Number.isFinite(k) || k <= 0) return null;
	if (typeof x !== "number" || !Number.isFinite(x) || typeof y !== "number" || !Number.isFinite(y)) return null;
	return { k, x, y };
}
