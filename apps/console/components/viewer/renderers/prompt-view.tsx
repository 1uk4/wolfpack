"use client";

import { createContext, useContext, useEffect } from "react";
import { KbMarkdown } from "@/components/kb/kb-markdown";
import { sourceText, type PromptGraph } from "@/src/core";
import type { ViewRendererProps } from "../registry";

/** One prompt block as the settings page's graph knows it. `id` is the graph node id (the prompt id for a one-prompt node), stable across reloads. */
export interface PromptBlock {
	id: string;
	title: string;
	/** Where the text comes from, in words (file included). */
	source: string;
	/** Where the block sits in its graph: step number, what comes before and after. */
	flow: string;
	/** One entry per prompt the node shows; empty for a step that runs no prompt. */
	texts: Array<{ label: string; text: string }>;
	note?: string;
}

/** The settings page provides its blocks; `null` while its prompts are still loading. */
export const PromptBlocksContext = createContext<{ blocks: PromptBlock[] | null }>({ blocks: null });

interface Row {
	id: string;
	label: string;
	text: string;
	source: "default" | "override";
	file?: string;
}

/** Every node of every graph as a block; the first graph that has an id wins. */
export function buildPromptBlocks(graphs: PromptGraph[], rows: Row[]): PromptBlock[] {
	const byId = new Map(rows.map((r) => [r.id, r] as const));
	const out = new Map<string, PromptBlock>();
	for (const g of graphs) {
		g.nodes.forEach((n, i) => {
			if (out.has(n.id)) return;
			const title = (id: string) => g.nodes.find((x) => x.id === id)?.title ?? id;
			const before = g.edges.filter((e) => e.to === n.id).map((e) => title(e.from));
			const after = g.edges.filter((e) => e.from === n.id).map((e) => title(e.to));
			const own = n.ids.map((id) => byId.get(id)).filter((r): r is Row => !!r);
			out.set(n.id, {
				id: n.id,
				title: n.title,
				source: own.length ? own.map(sourceText).join("; ") : "No prompt of its own",
				flow: `Step ${i + 1} of ${g.nodes.length} in ${g.title}.${before.length ? ` After: ${before.join(", ")}.` : ""}${after.length ? ` Before: ${after.join(", ")}.` : ""}`,
				texts: own.map((r) => ({ label: r.label, text: r.text })),
				...(n.note ? { note: n.note } : {}),
			});
		});
	}
	return [...out.values()];
}

/** Kind "prompt": one prompt block, read-only. */
export function PromptViewRenderer({ descriptor, onTitle }: ViewRendererProps) {
	const { blocks } = useContext(PromptBlocksContext);
	const block = blocks?.find((b) => b.id === descriptor.id) ?? null;
	useEffect(() => {
		if (block) onTitle(block.title);
	}, [block, onTitle]);
	if (!blocks) return <p className="p-4 text-sm text-muted-foreground" role="status">Loading prompts…</p>;
	if (!block) return <p className="p-4 text-sm text-muted-foreground" role="status">Prompt block not found: {descriptor.id}</p>;
	return (
		<div className="flex flex-col gap-3 p-4 text-sm" data-testid="prompt-view">
			<h2 className="text-base font-medium text-foreground">{block.title}</h2>
			<p className="text-muted-foreground" data-testid="prompt-source">{block.source}</p>
			<p className="text-muted-foreground" data-testid="prompt-flow">{block.flow}</p>
			{block.note ? <p className="text-muted-foreground">{block.note}</p> : null}
			{block.texts.map((t, i) => (
				<section key={i} className="flex flex-col gap-1">
					{block.texts.length > 1 ? <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{t.label}</h3> : null}
					<KbMarkdown>{t.text}</KbMarkdown>
				</section>
			))}
		</div>
	);
}
