"use client";

/**
 * The graph's detail card — one body per node kind (the model is
 * describeNode in src/core/kb-graph-model.ts):
 *   entry     title, summary, domain, section, maturity + "open"
 *   work      stage, parent, dependencies + "open"
 *   section   summary + "focus" (frames the section's entries)
 *   domain    counts
 *   den topic wolf + summary, minimal
 * Presentational: placement is the graph view's job.
 */
import Link from "next/link";
import type { CardLink, NodeCard } from "@/src/core";
import { RouteNav, type RouteNavModel } from "./graph-route-nav.tsx";

export const KIND_LABEL: Record<NodeCard["kind"], string> = {
	domain: "Domain",
	factory: "Factory",
	section: "Section",
	entry: "Entry",
	work: "Work",
	"den-topic": "Den topic",
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-3 text-xs">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="min-w-0 truncate text-right text-foreground">{children}</span>
		</div>
	);
}

export function LinkList({
	title,
	links,
	onSelectNode,
}: {
	title: string;
	links: readonly CardLink[];
	onSelectNode: (id: string) => void;
}) {
	if (links.length === 0) return null;
	return (
		<div className="mt-3 flex flex-col gap-0.5">
			<div className="text-xs text-muted-foreground">{title}</div>
			{links.map((l) => (
				<button
					key={l.id}
					type="button"
					onClick={() => onSelectNode(l.id)}
					className="flex min-w-0 items-center gap-1.5 rounded-md px-2 py-1 text-left text-sm text-foreground transition-colors hover:bg-accent"
				>
					<span className="min-w-0 flex-1 truncate">{l.label}</span>
				</button>
			))}
		</div>
	);
}

export function GraphCard({
	card,
	onFocus,
	onSelectNode,
	routeNav,
}: {
	card: NodeCard;
	/** The selected work item's route stepper (details above show the cursor's node). */
	routeNav?: RouteNavModel | null;
	/** Frame the graph on these nodes (the section card's "focus"). */
	onFocus: (ids: string[]) => void;
	/** Jump to another node (focus + open its card). */
	onSelectNode: (id: string) => void;
}) {
	return (
		<div data-testid="graph-card" data-kind={card.kind}>
			<div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{KIND_LABEL[card.kind]}</div>
			<div className="mt-0.5 text-sm font-medium leading-snug">{card.title}</div>
			{card.summary && <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{card.summary}</div>}

			<div className="mt-3 flex flex-col gap-1">
				{card.domain && card.kind !== "domain" && <Field label="Domain">{card.domain.label}</Field>}
				{card.section && <Field label="Section">{card.section.label}</Field>}
				{card.entryKind && <Field label="Kind">{card.entryKind}</Field>}
				{card.maturity && <Field label="Maturity">{card.maturity}</Field>}
				{card.stage && <Field label="Stage">{card.stage.replace(/_/g, " ")}</Field>}
				{card.workKind && <Field label="Type">{card.workKind}</Field>}
				{card.assignee && <Field label="Assignee">{card.assignee}</Field>}
				{card.wolf && <Field label="Wolf">{card.wolf}</Field>}
				{card.promotable !== undefined && <Field label="Promotable">{card.promotable ? "yes" : "private"}</Field>}
				{card.updated && <Field label="Updated">{card.updated}</Field>}
				{card.counts &&
					Object.entries(card.counts).map(([kind, n]) => (
						<Field key={kind} label={KIND_LABEL[kind as NodeCard["kind"]] ?? kind}>
							{n}
						</Field>
					))}
			</div>

			{routeNav && <RouteNav nav={routeNav} />}

			{card.parent && <LinkList title="Part of" links={[card.parent]} onSelectNode={onSelectNode} />}
			<LinkList title="Depends on" links={card.dependencies} onSelectNode={onSelectNode} />

			{(card.openHref || card.focusIds) && (
				<div className="mt-3 flex items-center gap-2">
					{card.openHref && (
						<Link
							href={card.openHref}
							className="rounded-lg border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent"
						>
							Open
						</Link>
					)}
					{card.focusIds && (
						<button
							type="button"
							onClick={() => onFocus(card.focusIds!)}
							className="rounded-lg border px-3 py-1 text-xs font-medium transition-colors hover:bg-accent"
						>
							Focus
						</button>
					)}
				</div>
			)}
		</div>
	);
}
