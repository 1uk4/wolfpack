"use client";

import { useEffect, useState } from "react";
import { BookOpenIcon, GaugeIcon, GitForkIcon, ListChecksIcon, ListTreeIcon, PinIcon, ScaleIcon, XIcon, type LucideIcon } from "lucide-react";
import { ChecklistItems } from "@/components/thread/checklist-card";
import { DecisionCard } from "@/components/thread/decision-card";
import { PlanGraphCard } from "@/components/thread/plan-graph-card";
import { setExpanded, syncObjectPins, unpin, useExpanded, useThreadPins, type Pin, type SyncObject } from "@/components/thread/pin-store";
import { useViewer } from "@/components/viewer/viewer-store";
import { cn } from "@/lib/utils";

/** A collapsed object block of the transcript, as the strip reads it. */
export interface StripObject {
	type: "checklist" | "decision" | "graph";
	id: string;
	rev: number;
	data: unknown;
	pinned?: boolean;
	pinRev?: number;
	/** Ordinal of the object's latest upsert (higher = newer). */
	recency?: number;
}

const titleOf = (data: unknown): string | undefined => {
	const t = (data as { title?: unknown } | null)?.title;
	return typeof t === "string" && t ? t : undefined;
};

/** Oldest first by recency, as syncObjectPins expects. */
export function toSyncObjects(objects: readonly StripObject[]): SyncObject[] {
	return [...objects]
		.sort((a, b) => (a.recency ?? 0) - (b.recency ?? 0))
		.map((o) => {
			const title = titleOf(o.data);
			return { type: o.type, id: o.id, rev: o.rev, ...(o.pinRev !== undefined ? { pinRev: o.pinRev } : {}), ...(o.pinned !== undefined ? { pinned: o.pinned } : {}), ...(title ? { title } : {}) };
		});
}

/** Keep the unified store in step with the transcript's objects (checklist, decision, graph). */
export function useSyncObjectPins(threadId: string, objects: readonly StripObject[]) {
	useEffect(() => {
		syncObjectPins(threadId, toSyncObjects(objects));
	}, [threadId, objects]);
}

const KIND_ICON: Record<string, LucideIcon> = { work: ListTreeIcon, kb: BookOpenIcon, checklist: ListChecksIcon, decision: ScaleIcon, graph: GitForkIcon, task: GaugeIcon };
const INLINE = new Set(["checklist", "decision", "graph"]);

function useWide(): boolean {
	const [wide, setWide] = useState(true);
	useEffect(() => {
		const mq = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 768px)") : null;
		if (!mq) return;
		const on = () => setWide(mq.matches);
		on();
		mq.addEventListener("change", on);
		return () => mq.removeEventListener("change", on);
	}, []);
	return wide;
}

function ObjectBody({ o }: { o: StripObject }) {
	if (o.type === "checklist") return <ChecklistItems items={(o.data as { items: never[] }).items} />;
	const Card = o.type === "decision" ? DecisionCard : PlanGraphCard;
	return <Card objectId={o.id} type={o.type} rev={o.rev} data={o.data as never} />;
}

/**
 * Every pin of the thread as a chip (kind icon, title, x). Object chips expand their card inline (a bottom sheet on
 * phones), one at a time; work and kb chips open the viewer.
 */
export function PinnedStrip({ wolf, threadId, objects, onDismiss }: { wolf: string; threadId: string; objects: readonly StripObject[]; onDismiss?: () => void }) {
	const pins = useThreadPins(threadId);
	const expanded = useExpanded(threadId);
	const v = useViewer(wolf, threadId);
	const wide = useWide();
	if (pins.length === 0) return null;
	const key = (p: Pin) => `${p.kind}:${p.id}`;
	const open = pins.find((p) => key(p) === expanded && INLINE.has(p.kind));
	const openObject = open ? objects.find((o) => o.type === open.kind && o.id === open.id) : undefined;
	const click = (p: Pin) => {
		if (INLINE.has(p.kind)) setExpanded(threadId, key(p) === expanded ? null : p);
		else v.openView({ kind: p.kind, id: p.id, ...(p.title ? { title: p.title } : {}) });
	};
	return (
		<div className="pointer-events-none flex min-h-0 flex-col" data-testid="pinned-strip">
			<div className="mx-auto flex min-h-0 w-full max-w-[46rem] flex-col gap-1 px-4 pt-1">
				<div data-testid="pinned-chips" className={cn("flex gap-1", wide ? "flex-wrap" : "flex-nowrap overflow-x-auto")}>
					{pins.map((p) => {
						const Icon = KIND_ICON[p.kind] ?? PinIcon;
						const label = p.title ?? p.id;
						return (
							<div key={key(p)} data-testid="pinned-chip" data-pin-key={key(p)} data-expanded={key(p) === expanded} className="pointer-events-auto flex max-w-full shrink-0 items-center rounded-full border bg-card text-xs text-card-foreground shadow-sm">
								<button type="button" data-testid="pinned-chip-open" title={label} aria-expanded={INLINE.has(p.kind) ? key(p) === expanded : undefined} onClick={() => click(p)} className="flex min-w-0 items-center gap-1.5 rounded-l-full py-1 pl-2.5 pr-1 hover:bg-accent/50 focus-visible:outline-2 focus-visible:outline-ring">
									<Icon className="size-3 shrink-0 text-muted-foreground" />
									<span className="max-w-[16rem] truncate">{label}</span>
								</button>
								<button type="button" aria-label={`Unpin ${label}`} data-testid="pinned-chip-dismiss" onClick={() => { unpin(threadId, p); onDismiss?.(); }} className="flex size-6 items-center justify-center rounded-r-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
									<XIcon className="size-3" />
								</button>
							</div>
						);
					})}
				</div>
				{open && openObject && wide && (
					<div data-testid="pinned-expanded" role="region" aria-label={open.title ?? open.kind} className="pointer-events-auto max-h-[50dvh] min-h-0 overflow-y-auto overscroll-contain rounded-xl border bg-card p-2 text-card-foreground shadow-lg">
						<ObjectBody o={openObject} />
					</div>
				)}
			</div>
			{open && openObject && !wide && (
				<div data-testid="pinned-sheet" role="dialog" aria-label={open.title ?? open.kind} className="pointer-events-auto fixed inset-x-0 bottom-0 z-40 flex max-h-[80dvh] flex-col rounded-t-xl border-t bg-card text-card-foreground shadow-2xl">
					<div className="flex shrink-0 items-center justify-between border-b px-3 py-2 text-sm font-medium">
						<span className="truncate">{open.title ?? open.kind}</span>
						<button type="button" aria-label="Close" data-testid="pinned-sheet-close" onClick={() => setExpanded(threadId, null)} className="flex size-7 items-center justify-center rounded-md hover:bg-accent">
							<XIcon className="size-4" />
						</button>
					</div>
					<div className="min-h-0 overflow-y-auto overscroll-contain p-3">
						<ObjectBody o={openObject} />
					</div>
				</div>
			)}
		</div>
	);
}
