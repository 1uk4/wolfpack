/**
 * The graph's docked side pane: pure helpers (width bounds + persistence,
 * the Record/log text the pane shows, the lazy-fetch cache). No React here.
 */
import { composeItemDocument } from "./item-document.ts";
import type { WorkRecordResponse } from "./kb.ts";

/** localStorage key of the pane's width (per-device). */
export const GRAPH_PANE_WIDTH_KEY = "lh.graph.pane-width.v1";
export const PANE_MIN_WIDTH = 280;
export const PANE_MAX_WIDTH = 720;
export const PANE_DEFAULT_WIDTH = 380;
/** The pane never takes more than this share of the viewport. */
const PANE_MAX_SHARE = 0.7;

/** Clamp a width to [min, max]; `viewport` (when known) caps it further. Non-finite → default. */
export function clampPaneWidth(width: number, viewport?: number): number {
	if (!Number.isFinite(width)) return PANE_DEFAULT_WIDTH;
	const max = viewport && viewport > 0 ? Math.max(PANE_MIN_WIDTH, Math.min(PANE_MAX_WIDTH, Math.floor(viewport * PANE_MAX_SHARE))) : PANE_MAX_WIDTH;
	return Math.round(Math.min(Math.max(width, PANE_MIN_WIDTH), max));
}

/** The stored width (a string off localStorage) → a usable width; absent/corrupt → the default. */
export function parsePaneWidth(raw: string | null | undefined): number {
	if (raw == null || raw.trim() === "") return PANE_DEFAULT_WIDTH;
	const n = Number(raw);
	return Number.isFinite(n) ? clampPaneWidth(n) : PANE_DEFAULT_WIDTH;
}

/** Remove HTML comments (the Record's source markers live in them), multi-line included. */
export function stripComments(md: string): string {
	return md.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** What the pane shows of a fetched work item. */
export interface PaneWork {
	successCriteria: string;
	/** The plan/spec as markdown (no Done-when, no Record). */
	document: string;
	/** Features only: the Record (decisions, changes, findings), comments stripped. */
	record: string;
	/** The newest ledger entries, newest first. */
	log: string[];
	tasks: { id: string; title: string; stage: string }[];
	/** Server-reported children list was cut. */
	truncated: boolean;
}

export const LOG_SHOWN = 10;

export function paneWork(item: WorkRecordResponse): PaneWork {
	return {
		successCriteria: item.successCriteria?.trim() ?? "",
		document: composeItemDocument({ plan: item.plan, successCriteria: undefined }, null),
		record: item.kind === "feature" ? stripComments(item.record) : "",
		log: (item.log ?? []).slice(-LOG_SHOWN).reverse(),
		tasks: item.kind === "feature" ? (item.children ?? []).map((c) => ({ id: c.id, title: c.title, stage: c.stage })) : [],
		truncated: item.childrenTruncated === true,
	};
}

/** A small TTL + size bounded cache for the pane's lazy fetches. */
export class PaneCache<T> {
	private map = new Map<string, { at: number; value: T }>();
	constructor(
		private readonly max = 40,
		private readonly ttlMs = 60_000,
		private readonly now: () => number = Date.now,
	) {}
	get(key: string): T | undefined {
		const hit = this.map.get(key);
		if (!hit) return undefined;
		if (this.now() - hit.at > this.ttlMs) {
			this.map.delete(key);
			return undefined;
		}
		return hit.value;
	}
	set(key: string, value: T): void {
		this.map.delete(key);
		this.map.set(key, { at: this.now(), value });
		while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
	}
	clear(): void {
		this.map.clear();
	}
}
