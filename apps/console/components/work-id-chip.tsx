"use client";

/**
 * Work item chips: a full `work-<domain>-<id>` id in a message renders as a compact chip (the short id); hover
 * (small delay), keyboard focus or a tap opens a card with the item's facts and two actions:
 *  - Open thread: the item's feature thread (a task → its parent feature's), via POST /api/wolves/<wolf>/threads
 *    {kind:"feature", workItemId} (openFeatureThread), then /wolf/<wolf>/thread/<slug>. Disabled with no thread.
 *  - Open in Work: the Work view (WorkViewContext open + select).
 * Lookup: GET /api/wolves/<wolf>/work/<id>/record (fetchWorkRecord) over the librarian then other online wolves,
 * fetched on first open only, cached per id (module level, in-flight dedupe, ~60s TTL). Inside a button (card
 * options) the chip is inert plain text: InertMarkdown provides that context.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { cn } from "@/lib/utils";
import { fetchWolves, fetchWorkRecord, openFeatureThread } from "@/components/kb-client";
import { useWorkView } from "@/components/work-view-entry";
import { featureThreadWolves, findLibrarian, resolveWork, threadHref, workWolfCandidates, type WorkRecordResponse } from "@/src/core";
import { shortWorkId, workIdDomain } from "@/src/core";

// ─── Interactive-ancestor context ────────────────────────────────────────────

const InertContext = createContext(false);
/** Wrap markdown that renders inside a <button>: links and work ids become plain text (no nested interactive). */
export const InertMarkdown = InertContext.Provider;
export const useInertMarkdown = (): boolean => useContext(InertContext);

// ─── Lookup + cache ──────────────────────────────────────────────────────────

export type WorkLookup =
	| { kind: "ok"; wolf: string; item: WorkRecordResponse; parent: WorkRecordResponse | null; threadWolves: string[] }
	| { kind: "unknown" }
	| { kind: "unavailable"; message: string };

export const WORK_CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: WorkLookup }>();
const inflight = new Map<string, Promise<WorkLookup>>();

export function resetWorkLookupCache(): void {
	cache.clear();
	inflight.clear();
}

async function fetchLookup(id: string): Promise<WorkLookup> {
	const w = await fetchWolves();
	const wolves = w.ok ? w.data.wolves : [];
	const hit = await resolveWork(workWolfCandidates(findLibrarian(wolves)?.name ?? null, wolves), id, fetchWorkRecord);
	if (hit.kind === "none") return { kind: "unavailable", message: "No wolf is online to look this up." };
	if (!hit.result.ok) return hit.result.reason === "not_found" ? { kind: "unknown" } : { kind: "unavailable", message: hit.result.message };
	const item = hit.result.data;
	let parent: WorkRecordResponse | null = null;
	if (item.partOf) {
		const p = await fetchWorkRecord(hit.wolf, item.partOf);
		if (p.ok) parent = p.data;
	}
	return { kind: "ok", wolf: hit.wolf, item, parent, threadWolves: featureThreadWolves(wolves) };
}

/** Cached lookup: one request per id per TTL, concurrent callers share it. Transient failures are not cached. */
export function lookupWorkItem(id: string, now: () => number = Date.now): Promise<WorkLookup> {
	const c = cache.get(id);
	if (c && now() - c.at < WORK_CACHE_TTL_MS) return Promise.resolve(c.value);
	const f = inflight.get(id);
	if (f) return f;
	const p = fetchLookup(id)
		.then((value) => {
			if (value.kind !== "unavailable") cache.set(id, { at: now(), value });
			return value;
		})
		.finally(() => inflight.delete(id));
	inflight.set(id, p);
	return p;
}

// ─── Card ────────────────────────────────────────────────────────────────────

const CRITERIA_CHARS = 200;
export const criteriaExcerpt = (s: string | undefined): string => {
	const t = (s ?? "").replace(/\s+/g, " ").trim();
	return t.length > CRITERIA_CHARS ? `${t.slice(0, CRITERIA_CHARS).trimEnd()}…` : t;
};

/** Features: "n/m shipped" over the non-archived children. */
export function shippedProgress(item: WorkRecordResponse): string | null {
	if (item.kind !== "feature" || !item.children) return null;
	const kids = item.stage === "archived" ? item.children : item.children.filter((c) => c.stage !== "archived");
	if (kids.length === 0) return null;
	return `${kids.filter((c) => c.stage === "shipped" || c.stage === "live").length}/${kids.length} shipped`;
}

/** The feature whose thread this item opens: itself for a feature, else its parent (null: none). */
export function threadFeatureId(item: WorkRecordResponse): string | null {
	if (item.container) return null;
	return item.kind === "feature" ? item.id : (item.partOf ?? null);
}

const claimHolder = (item: WorkRecordResponse): string | null => {
	const o = item as unknown as Record<string, unknown>;
	const v = o.claimedBy ?? o.claimHolder ?? o.claim;
	if (typeof v === "string" && v) return v;
	const name = (v as { holder?: unknown; wolf?: unknown } | undefined)?.holder ?? (v as { wolf?: unknown } | undefined)?.wolf;
	return typeof name === "string" && name ? name : null;
};

export function WorkItemCard({
	id,
	lookup,
	onOpenThread,
	onOpenWork,
	threadError,
}: {
	id: string;
	lookup: WorkLookup | null;
	onOpenThread: () => void;
	onOpenWork: () => void;
	threadError?: string | null;
}) {
	if (!lookup) return <p className="text-muted-foreground">Loading…</p>;
	if (lookup.kind === "unknown") return <p data-testid="work-card-unknown" className="text-muted-foreground">Unknown item <code className="font-mono">{id}</code></p>;
	if (lookup.kind === "unavailable") return <p className="text-muted-foreground">Could not look this up: {lookup.message}</p>;
	const { item, parent } = lookup;
	const progress = shippedProgress(item);
	const criteria = criteriaExcerpt(item.successCriteria);
	const holder = claimHolder(item);
	const featureId = threadFeatureId(item);
	const canThread = featureId !== null && lookup.threadWolves.length > 0;
	const fact = (label: string, value: string) => (
		<span data-fact={label}>
			<span className="text-muted-foreground">{label} </span>
			{value}
		</span>
	);
	return (
		<div className="flex flex-col gap-2">
			<p className="font-medium leading-snug" data-testid="work-card-title">{item.title}</p>
			<p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
				{fact("kind", item.kind)}
				{fact("stage", item.stage)}
				{fact("domain", item.domain ?? workIdDomain(id))}
				{progress && fact("tasks", progress)}
				{holder && fact("claimed by", holder)}
			</p>
			{item.partOf && (
				<p className="text-xs" data-fact="feature">
					<span className="text-muted-foreground">feature </span>
					{parent?.title ?? item.partOf}
				</p>
			)}
			{criteria && <p className="text-xs text-muted-foreground" data-testid="work-card-criteria">{criteria}</p>}
			{threadError && <p className="text-xs text-destructive" role="alert">{threadError}</p>}
			<div className="flex gap-2">
				<button type="button" data-testid="work-card-thread" disabled={!canThread} onClick={onOpenThread} className="rounded-md border border-border px-2 py-1 text-xs enabled:hover:bg-accent disabled:opacity-50">
					Open thread
				</button>
				<button type="button" data-testid="work-card-work" onClick={onOpenWork} className="rounded-md border border-border px-2 py-1 text-xs hover:bg-accent">
					Open in Work
				</button>
			</div>
		</div>
	);
}

// ─── Chip ────────────────────────────────────────────────────────────────────

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 150;
const CHIP = "inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] align-baseline";

export function WorkIdChip({ id }: { id: string }) {
	const inert = useInertMarkdown();
	const short = shortWorkId(id);
	if (inert) return <span className={CHIP} data-work-id={id} title={id}>{short}</span>;
	return <InteractiveChip id={id} short={short} />;
}

function InteractiveChip({ id, short }: { id: string; short: string }) {
	const router = useContext(AppRouterContext);
	const workView = useWorkView();
	const ref = useRef<HTMLSpanElement>(null);
	const [open, setOpen] = useState(false);
	const [lookup, setLookup] = useState<WorkLookup | null>(null);
	const [threadError, setThreadError] = useState<string | null>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const cardRef = useRef<HTMLDivElement>(null);

	const schedule = useCallback((next: boolean, ms: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(next), ms);
	}, []);
	useEffect(() => () => clearTimeout(timer.current), []);

	// Lazy: the first open fetches (cached + deduped across chips).
	useEffect(() => {
		if (!open) return;
		let live = true;
		void lookupWorkItem(id).then((v) => live && setLookup(v));
		return () => {
			live = false;
		};
	}, [open, id]);

	useLayoutEffect(() => {
		if (!open || !ref.current) return;
		const r = ref.current.getBoundingClientRect?.() ?? { left: 8, bottom: 0 };
		setPos({ left: Math.max(8, Math.min(r.left, (window.innerWidth || 1024) - 328)), top: r.bottom + 6 });
	}, [open, lookup]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		const onDown = (e: Event) => {
			const t = e.target as Node;
			if (!ref.current?.contains(t) && !cardRef.current?.contains(t)) setOpen(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDown);
		};
	}, [open]);

	const go = (href: string) => (router ? router.push(href) : window.location.assign(href));
	const openWork = () => {
		setOpen(false);
		workView.open();
		workView.select(id);
	};
	const openThread = async () => {
		if (!lookup || lookup.kind !== "ok") return;
		const featureId = threadFeatureId(lookup.item);
		if (!featureId) return;
		setThreadError(null);
		let last = "No wolf is online to open the thread.";
		for (const wolf of lookup.threadWolves) {
			const r = await openFeatureThread(wolf, featureId);
			if (r.ok) {
				setOpen(false);
				return go(threadHref(wolf, r.data.id));
			}
			last = r.message;
		}
		setThreadError(last);
	};

	const unknown = lookup?.kind === "unknown";
	return (
		<>
			<span
				ref={ref}
				role="link"
				tabIndex={0}
				data-work-id={id}
				aria-expanded={open}
				className={cn(CHIP, "cursor-pointer hover:bg-accent focus-visible:outline focus-visible:outline-2", unknown && "text-muted-foreground opacity-70")}
				onMouseEnter={() => schedule(true, HOVER_OPEN_MS)}
				onMouseLeave={() => schedule(false, HOVER_CLOSE_MS)}
				onFocus={() => schedule(true, 0)}
				onClick={() => {
					clearTimeout(timer.current);
					setOpen((o) => !o);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						setOpen((o) => !o);
					}
				}}
			>
				{short}
			</span>
			{open &&
				pos &&
				typeof document !== "undefined" &&
				createPortal(
					<div
						ref={cardRef}
						role="dialog"
						aria-label={`Work item ${id}`}
						data-testid="work-card"
						className="fixed z-50 w-80 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
						style={{ left: pos.left, top: pos.top }}
						onMouseEnter={() => clearTimeout(timer.current)}
						onMouseLeave={() => schedule(false, HOVER_CLOSE_MS)}
					>
						<WorkItemCard id={id} lookup={lookup} onOpenThread={() => void openThread()} onOpenWork={openWork} threadError={threadError} />
					</div>,
					document.body,
				)}
		</>
	);
}
