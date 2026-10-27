/**
 * COMMAND PALETTE CORE (⌘K) — pure item building + ranking. No DOM, no IO.
 * The component (components/command-palette.tsx) gathers the sources
 * (wolves, threads, the librarian graph) and renders what rankPalette
 * returns; everything decidable lives here so it is testable.
 */

import { fuzzyScore } from "./fuzzy.ts";
import { PIPELINE_HREF } from "./kb.ts";
import type { KbGraphNode } from "./kb.ts";
import { threadHref } from "./thread-adapter.ts";

export type PaletteKind = "command" | "wolf" | "thread" | "entry" | "work";

/** The commands that are not plain navigation. */
export type PaletteCommandId = "switch-model" | "consolidate" | "promote";

export interface PaletteItem {
	/** Unique across the palette (also the cmdk row value). */
	id: string;
	kind: PaletteKind;
	label: string;
	/** Muted secondary text (wolf name, domain, stage, ...). */
	hint?: string;
	/** Extra searchable text that is not displayed. */
	keywords?: string[];
	/** Navigation target; absent for action commands. */
	href?: string;
	/** Action to run instead of navigating. */
	command?: PaletteCommandId;
}

/** Display order of the groups. */
export const PALETTE_GROUPS: readonly PaletteKind[] = ["command", "wolf", "thread", "entry", "work"];

export const PALETTE_GROUP_LABELS: Record<PaletteKind, string> = {
	command: "Commands",
	wolf: "Wolves",
	thread: "Threads",
	entry: "Entries",
	work: "Work items",
};

/** Per-group caps. An empty query is a menu, not a search: the big KB
 *  groups stay hidden until the user types. */
export const PALETTE_CAPS: Record<PaletteKind, number> = { command: 8, wolf: 6, thread: 8, entry: 8, work: 8 };
export const PALETTE_EMPTY_CAPS: Record<PaletteKind, number> = { command: 8, wolf: 5, thread: 5, entry: 0, work: 0 };

export interface PaletteGroup {
	kind: PaletteKind;
	label: string;
	items: PaletteItem[];
}

/** The wolf of a `/wolf/<name>/...` route, else null (decoded). */
export function currentWolfOf(pathname: string | null | undefined): string | null {
	const m = /^\/wolf\/([^/]+)/.exec(pathname ?? "");
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]!);
	} catch {
		return m[1]!;
	}
}

/** The fixed commands; memory commands only exist with a current wolf. */
export function buildCommandItems(currentWolf: string | null): PaletteItem[] {
	const items: PaletteItem[] = [
		{ id: "cmd:graph", kind: "command", label: "Open graph", href: "/", keywords: ["home", "knowledge"] },
		{ id: "cmd:pipeline", kind: "command", label: "Open pipeline", href: PIPELINE_HREF, keywords: ["kb", "librarian"] },
		{ id: "cmd:model", kind: "command", label: "Switch model", command: "switch-model", keywords: ["picker", "llm"] },
	];
	if (currentWolf) {
		items.push(
			{ id: "cmd:consolidate", kind: "command", label: "Consolidate memory", hint: currentWolf, command: "consolidate" },
			{ id: "cmd:promote", kind: "command", label: "Promote memory", hint: currentWolf, command: "promote" },
		);
	}
	return items;
}

export function wolfItems(wolves: readonly { name: string }[]): PaletteItem[] {
	return wolves.map((w) => ({ id: `wolf:${w.name}`, kind: "wolf", label: w.name, href: `/wolf/${encodeURIComponent(w.name)}` }));
}

export function threadItems(wolf: string, threads: readonly { id: string; title: string }[]): PaletteItem[] {
	return threads.map((t) => ({
		id: `thread:${wolf}:${t.id}`,
		kind: "thread",
		label: t.title || "Untitled",
		hint: wolf,
		href: threadHref(wolf, t.id),
	}));
}

/** `/?focus=<nodeId>` — GraphHome focuses the node and opens its card. */
export function focusHref(nodeId: string): string {
	return `/?focus=${encodeURIComponent(nodeId)}`;
}

/** Entry and work nodes of the librarian graph (domains, sections and den
 *  topics are structure, not search targets). */
export function graphItems(nodes: readonly KbGraphNode[]): PaletteItem[] {
	const out: PaletteItem[] = [];
	for (const n of nodes) {
		if (n.kind === "entry") {
			out.push({
				id: n.id,
				kind: "entry",
				label: n.label,
				hint: n.domain,
				keywords: [n.entryKind, n.summary].filter((s): s is string => !!s),
				href: focusHref(n.id),
			});
		} else if (n.kind === "work") {
			out.push({
				id: n.id,
				kind: "work",
				label: n.label,
				hint: [n.workKind, n.stage].filter(Boolean).join(" · ") || n.domain,
				keywords: [n.domain, n.assignee, n.workKind, n.stage].filter((s): s is string => !!s),
				href: focusHref(n.id),
			});
		}
	}
	return out;
}

/** Rank `items` for `query`, grouped by kind in PALETTE_GROUPS order,
 *  best-first inside a group (stable on ties), capped, empty groups
 *  dropped. Label matches count; keywords/hints only break through when
 *  the label does not match (they ride as extra fields). */
export function rankPalette(query: string, items: readonly PaletteItem[]): PaletteGroup[] {
	const q = query.trim();
	const caps = q ? PALETTE_CAPS : PALETTE_EMPTY_CAPS;
	const groups: PaletteGroup[] = [];
	for (const kind of PALETTE_GROUPS) {
		const scored: { item: PaletteItem; score: number }[] = [];
		for (const item of items) {
			if (item.kind !== kind) continue;
			const score = fuzzyScore(q, item.label, item.hint ?? "", ...(item.keywords ?? []));
			if (score !== null) scored.push({ item, score });
		}
		scored.sort((a, b) => b.score - a.score);
		const shown = scored.slice(0, caps[kind]).map((s) => s.item);
		if (shown.length) groups.push({ kind, label: PALETTE_GROUP_LABELS[kind], items: shown });
	}
	return groups;
}
