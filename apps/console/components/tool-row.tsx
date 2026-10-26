"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { ComponentType } from "react";
import type { ReactNode } from "react";
import { summarizeGroup, type ArtifactPartProps, type ToolEntry, type ToolStatus } from "@/src/core";

/**
 * One tool call as a compact row: name, one-line argument summary, status.
 * Collapsed by default; expands to the result (truncated, "show more").
 * Same recipe as ToolCallCard / LiveToolCard (a quiet <details> one-liner),
 * but data-driven by a ToolEntry so a live turn and a reloaded history
 * render identically.
 */
const PREVIEW_LINES = 12;
const PREVIEW_CHARS = 1200;

export function truncateResult(text: string): { shown: string; truncated: boolean } {
	const lines = text.split("\n");
	let shown = lines.slice(0, PREVIEW_LINES).join("\n");
	if (shown.length > PREVIEW_CHARS) shown = shown.slice(0, PREVIEW_CHARS);
	return { shown, truncated: shown.length < text.length };
}

const STATUS_LABEL = { running: "running", done: "done", error: "error", pending: "no result" } as const;

export function ToolRow({
	entry,
	artifact,
}: {
	entry: ToolEntry;
	/** A registered artifact renderer for this tool + its view part: it IS the expanded content (settled calls only). */
	artifact?: { Renderer: ComponentType<ArtifactPartProps>; part: ArtifactPartProps["part"] };
}) {
	const [full, setFull] = useState(false);
	const failed = entry.status === "error";
	const result = entry.result ?? "";
	const { shown, truncated } = truncateResult(result);
	return (
		<details
			data-testid="tool-row"
			data-tool={entry.name}
			data-status={entry.status}
			className="group my-1 w-full min-w-0 max-w-2xl select-none"
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
				{entry.status === "running" && <BrailleSpinner label={`${entry.name} — running`} />}
				{entry.status === "running" ? (
					<Shimmer duration={1} className="text-xs font-medium uppercase tracking-wide">
						{entry.name}
					</Shimmer>
				) : (
					<span className={`font-medium uppercase tracking-wide ${failed ? "text-red-500" : ""}`}>{entry.name}</span>
				)}
				{entry.summary && <span className="min-w-0 truncate font-mono text-[11px]">{entry.summary}</span>}
				<span data-testid="tool-row-status" className={`ml-auto shrink-0 ${failed ? "text-red-500" : "opacity-60"}`}>
					{STATUS_LABEL[entry.status]}
				</span>
				<ChevronRight className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-2 rounded-xl border bg-card p-3 text-xs">
				{artifact && (entry.status === "done" || entry.status === "error") ? (
					<artifact.Renderer part={artifact.part} />
				) : entry.status === "running" || entry.status === "pending" ? (
					<div className="italic text-muted-foreground">{entry.status === "running" ? "running…" : "no result recorded"}</div>
				) : (
					<>
						{entry.command && (
							<pre
								data-testid="tool-row-command"
								className="select-text mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
							>
								{entry.command}
							</pre>
						)}
						<div className="mb-1 font-medium uppercase tracking-wide text-muted-foreground">{failed ? "Error" : "Output"}</div>
						<pre
							data-testid="tool-row-output"
							className={`select-text max-h-96 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed ${failed ? "text-red-500" : ""}`}
						>
							{full ? result : shown || "(empty)"}
						</pre>
						{truncated && !full && (
							<button type="button" onClick={() => setFull(true)} className="mt-1 text-[11px] underline">
								show more
							</button>
						)}
					</>
				)}
			</div>
		</details>
	);
}

/**
 * A run of consecutive calls as ONE collapsed line: per-name counts, the latest
 * (or running) call's summary, the overall status. Expands to the individual rows.
 */
export function ToolGroup({ entries, children }: { entries: readonly ToolEntry[]; children: ReactNode }) {
	const { counts, latest, status } = summarizeGroup(entries);
	const failed = status === "error";
	const label: ToolStatus = status;
	return (
		<details data-testid="tool-group" data-status={status} className="group my-1 w-full min-w-0 max-w-2xl select-none">
			<summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
				{status === "running" && <BrailleSpinner label="tools — running" />}
				<span data-testid="tool-group-counts" className={`shrink-0 font-medium uppercase tracking-wide ${failed ? "text-red-500" : ""}`}>
					{counts.map((c) => (c.count > 1 ? `${c.name} ×${c.count}` : c.name)).join(" · ")}
				</span>
				{latest.summary && <span className="min-w-0 truncate font-mono text-[11px]">{latest.summary}</span>}
				<span data-testid="tool-group-status" className={`ml-auto shrink-0 ${failed ? "text-red-500" : "opacity-60"}`}>
					{STATUS_LABEL[label]}
				</span>
				<ChevronRight className="size-3 shrink-0 opacity-50 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-1 min-w-0 pl-3">{children}</div>
		</details>
	);
}
