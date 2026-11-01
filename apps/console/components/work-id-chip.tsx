"use client";

/**
 * Work item chips: a full `work-<domain>-<id>` id in a message renders as a compact chip (the short id); hover
 * (small delay), keyboard focus or a tap opens a card with the item's facts and two actions:
 *  - Open thread: the item's feature thread (a task → its parent feature's). An existing one is found in the wolves'
 *    GET /api/wolves/<wolf>/threads lists (a thread whose boundItem/boundWorkItem is the feature; the current wolf
 *    first) and opened at /wolf/<wolf>/thread/<slug>. With none the button reads "Start thread" and creates it on the
 *    CURRENT wolf only (POST /api/wolves/<wolf>/threads {kind:"feature", workItemId}); no fallback to other wolves.
 *    Disabled when the item has no feature.
 *  - Open in Work: the Work view (WorkViewContext open + select).
 * Lookup: GET /api/wolves/<wolf>/work/<id>/record (fetchWorkRecord) over the librarian then other online wolves,
 * fetched on first open only, cached per id (module level, in-flight dedupe, ~60s TTL). Inside a button (card
 * options) the chip is inert plain text: InertMarkdown provides that context.
 */
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { createPortal } from "react-dom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { cn } from "@/lib/utils";
import { fetchWolves, fetchWorkRecord, openFeatureThread, type KbResult } from "@/components/kb-client";
import { useWorkView } from "@/components/work-view-entry";
import { featureThreadWolves, findLibrarian, resolveWork, threadHref, workWolfCandidates, type WorkRecordResponse } from "@/src/core";
import { shortWorkId, workIdDomain } from "@/src/core";

// ─── Interactive-ancestor context ────────────────────────────────────────────

const InertContext = createContext(false);
/** Wrap markdown that renders inside a <button>: links and work ids become plain text (no nested interactive). */
export const InertMarkdown = InertContext.Provider;
export const useInertMarkdown = (): boolean => useContext(InertContext);

// ─── Lookup + cache ──────────────────────────────────────────────────────────

export interface FeatureThread {
	wolf: string;
	id: string;
}

export type WorkLookup =
	| { kind: "ok"; wolf: string; item: WorkRecordResponse; parent: WorkRecordResponse | null; threadWolves: string[]; thread: FeatureThread | null }
	| { kind: "unknown" }
	| { kind: "unavailable"; message: string };

export const WORK_CACHE_TTL_MS = 60_000;
const WOLVES_TTL_MS = 10_000;
const cache = new Map<string, { at: number; value: WorkLookup }>();
const inflight = new Map<string, Promise<WorkLookup>>();
let wolvesCache: { at: number; value: Promise<KbResult<{ wolves: { id: string; name: string; host: string; status: string; librarian?: boolean }[] }>> } | null = null;

export function resetWorkLookupCache(): void {
	cache.clear();
	inflight.clear();
	wolvesCache = null;
}

/** One short-lived wolves list shared by every lookup. */
function sharedWolves(now: number) {
	if (!wolvesCache || now - wolvesCache.at > WOLVES_TTL_MS) wolvesCache = { at: now, value: fetchWolves() };
	return wolvesCache.value;
}

/** The feature whose thread this item opens: itself for a feature, else its parent (null: none). */
export function threadFeatureId(item: WorkRecordResponse): string | null {
	if (item.container) return null;
	return item.kind === "feature" ? item.id : (item.partOf ?? null);
}

/** The wolf whose thread page we are on (`/wolf/<wolf>/thread/<slug>`), or null. */
export const currentWolfOf = (pathname: string | null): string | null => {
	const m = pathname ? /^\/wolf\/([^/]+)\/thread\//.exec(pathname) : null;
	if (!m) return null;
	try {
		return decodeURIComponent(m[1]!);
	} catch {
		return null;
	}
};

/** An existing thread bound to the feature: each wolf's thread list in turn (the current wolf first). */
export async function findFeatureThread(featureId: string, wolves: readonly string[]): Promise<FeatureThread | null> {
	for (const wolf of wolves) {
		try {
			const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/threads`, { cache: "no-store" });
			if (!res.ok) continue;
			const list = ((await res.json()) as { threads?: { id: string; kind?: string; boundItem?: string; boundWorkItem?: string }[] }).threads ?? [];
			const hit = list.find((t) => t.kind === "feature" && (t.boundItem ?? t.boundWorkItem) === featureId) ?? list.find((t) => (t.boundItem ?? t.boundWorkItem) === featureId && t.kind !== "task");
			if (hit) return { wolf, id: hit.id };
		} catch {
			/* an unreachable wolf: try the next */
		}
	}
	return null;
}

async function fetchLookup(id: string, current: string | null, now: number): Promise<WorkLookup> {
	const w = await sharedWolves(now);
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
	const threadWolves = featureThreadWolves(wolves);
	const featureId = threadFeatureId(item);
	const order = [...(current ? [current] : []), ...threadWolves.filter((n) => n !== current)];
	const thread = featureId ? await findFeatureThread(featureId, order) : null;
	return { kind: "ok", wolf: hit.wolf, item, parent, threadWolves, thread };
}

/** Cached lookup: one request per id per TTL, concurrent callers share it. Transient failures are not cached. */
export function lookupWorkItem(id: string, current: string | null = null, now: () => number = Date.now): Promise<WorkLookup> {
	const c = cache.get(id);
	if (c && now() - c.at < WORK_CACHE_TTL_MS) return Promise.resolve(c.value);
	const f = inflight.get(id);
	if (f) return f;
	const p = fetchLookup(id, current, now())
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

export function WorkItemCard({
	id,
	lookup,
	onOpenThread,
	onOpenWork,
	threadError,
	canStart = true,
}: {
	id: string;
	lookup: WorkLookup | null;
	onOpenThread: () => void;
	onOpenWork: () => void;
	threadError?: string | null;
	/** A wolf to start a missing thread on exists. */
	canStart?: boolean;
}) {
	if (!lookup) return <p className="text-muted-foreground">Loading…</p>;
	if (lookup.kind === "unknown") return <p data-testid="work-card-unknown" className="text-muted-foreground">Unknown item <code className="font-mono">{id}</code></p>;
	if (lookup.kind === "unavailable") return <p className="text-muted-foreground">Could not look this up: {lookup.message}</p>;
	const { item, parent } = lookup;
	const progress = shippedProgress(item);
	const criteria = criteriaExcerpt(item.successCriteria);
	const featureId = threadFeatureId(item);
	const canThread = featureId !== null && (lookup.thread !== null || canStart);
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
					{featureId !== null && lookup.thread === null ? "Start thread" : "Open thread"}
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
const CARD_W = 320;
const CHIP = "inline-block rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] align-baseline";

export function WorkIdChip({ id }: { id: string }) {
	const inert = useInertMarkdown();
	const short = shortWorkId(id);
	if (inert) return <span className={CHIP} data-work-id={id} title={id}>{short}</span>;
	return <InteractiveChip id={id} short={short} />;
}

/** How the card was opened: a hover closes on mouse leave; focus on blur; click/tap/Enter stay until dismissed. */
type OpenedBy = "hover" | "focus" | "click" | "key";

function InteractiveChip({ id, short }: { id: string; short: string }) {
	const router = useContext(AppRouterContext);
	const currentWolf = currentWolfOf(usePathname());
	const workView = useWorkView();
	const ref = useRef<HTMLSpanElement>(null);
	const cardRef = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const openedBy = useRef<OpenedBy>("hover");
	const pressed = useRef(false);
	const focusCard = useRef(false);
	const [lookup, setLookup] = useState<WorkLookup | null>(null);
	const [threadError, setThreadError] = useState<string | null>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const openWith = useCallback((how: OpenedBy) => {
		clearTimeout(timer.current);
		// A stronger opener sticks: a click on a hover-opened card keeps it open past mouse leave.
		const rank: Record<OpenedBy, number> = { hover: 0, focus: 1, click: 2, key: 3 };
		setOpen((was) => {
			if (!was || rank[how] > rank[openedBy.current]) openedBy.current = how;
			return true;
		});
		if (how === "key") focusCard.current = true;
	}, []);
	const close = useCallback((restore = true) => {
		clearTimeout(timer.current);
		if (restore && cardRef.current && typeof document !== "undefined" && cardRef.current.contains(document.activeElement)) ref.current?.focus();
		setOpen(false);
	}, []);
	const scheduleHover = useCallback((next: boolean, ms: number) => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => {
			if (next) openWith("hover");
			else if (openedBy.current === "hover") setOpen(false);
		}, ms);
	}, [openWith]);
	useEffect(() => () => clearTimeout(timer.current), []);

	// Lazy: the first open fetches (cached + deduped across chips).
	useEffect(() => {
		if (!open) return;
		let live = true;
		void lookupWorkItem(id, currentWolf).then((v) => live && setLookup(v));
		return () => {
			live = false;
		};
	}, [open, id, currentWolf]);

	const place = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		const r = el.getBoundingClientRect?.() ?? { left: 8, top: 0, bottom: 0 };
		const vw = window.innerWidth || 1024;
		const vh = window.innerHeight || 768;
		const h = cardRef.current?.offsetHeight || 220;
		const below = r.bottom + 6;
		const top = below + h + 8 > vh && r.top - h - 6 > 0 ? r.top - h - 6 : below;
		setPos({ left: Math.max(8, Math.min(r.left, vw - CARD_W - 8)), top });
	}, []);
	useLayoutEffect(() => {
		if (open) place();
	}, [open, lookup, place]);
	useEffect(() => {
		if (!open) return;
		window.addEventListener("scroll", place, true);
		window.addEventListener("resize", place);
		return () => {
			window.removeEventListener("scroll", place, true);
			window.removeEventListener("resize", place);
		};
	}, [open, place]);

	// Opened from the keyboard (Enter): focus moves into the card once it is mounted.
	useEffect(() => {
		if (open && pos && focusCard.current) {
			focusCard.current = false;
			cardRef.current?.focus();
		}
	}, [open, pos, lookup]);

	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				close();
				if (document.activeElement !== ref.current) ref.current?.focus?.();
			}
		};
		const onDown = (e: Event) => {
			const t = e.target as Node;
			if (!ref.current?.contains(t) && !cardRef.current?.contains(t)) close(false);
		};
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDown);
		return () => {
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDown);
		};
	}, [open, close]);

	const go = (href: string) => (router ? router.push(href) : window.location.assign(href));
	const openWork = () => {
		close(false);
		workView.open();
		workView.select(id);
	};
	const openThread = async () => {
		if (!lookup || lookup.kind !== "ok") return;
		setThreadError(null);
		if (lookup.thread) {
			close(false);
			return go(threadHref(lookup.thread.wolf, lookup.thread.id));
		}
		const featureId = threadFeatureId(lookup.item);
		const wolf = currentWolf ?? lookup.threadWolves[0];
		if (!featureId || !wolf) return;
		// Create on the current wolf only: an error (invalid request, already bound, offline) is shown, never retried elsewhere.
		const r = await openFeatureThread(wolf, featureId);
		if (r.ok) {
			cache.delete(id);
			close(false);
			return go(threadHref(wolf, r.data.id));
		}
		setThreadError(r.message);
	};

	const unknown = lookup?.kind === "unknown";
	return (
		<>
			<span
				ref={ref}
				role="link"
				tabIndex={0}
				aria-haspopup="dialog"
				data-work-id={id}
				aria-expanded={open}
				className={cn(CHIP, "cursor-pointer hover:bg-accent focus-visible:outline focus-visible:outline-2", unknown && "text-muted-foreground opacity-70")}
				onMouseEnter={() => scheduleHover(true, HOVER_OPEN_MS)}
				onMouseLeave={() => scheduleHover(false, HOVER_CLOSE_MS)}
				onPointerDown={() => {
					pressed.current = true;
				}}
				onMouseDown={() => {
					pressed.current = true;
				}}
				onFocus={(e) => {
					// A press focuses before it clicks: the click opens. Only keyboard focus opens on its own.
					if (pressed.current) return;
					let visible = true;
					try {
						visible = e.currentTarget.matches(":focus-visible");
					} catch {
						/* no :focus-visible support: treat as keyboard */
					}
					if (visible) openWith("focus");
				}}
				onBlur={(e) => {
					pressed.current = false;
					if (openedBy.current === "focus" && !cardRef.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
				}}
				onClick={() => {
					pressed.current = false;
					openWith("click");
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						openWith("key");
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
						tabIndex={-1}
						aria-label={`Work item ${id}`}
						data-testid="work-card"
						className="fixed z-50 w-80 rounded-lg border border-border bg-popover p-3 text-sm text-popover-foreground shadow-lg outline-none"
						style={{ left: pos.left, top: pos.top }}
						onMouseEnter={() => clearTimeout(timer.current)}
						onMouseLeave={() => scheduleHover(false, HOVER_CLOSE_MS)}
					>
						<WorkItemCard id={id} lookup={lookup} onOpenThread={() => void openThread()} onOpenWork={openWork} threadError={threadError} canStart={currentWolf !== null || (lookup?.kind === "ok" && lookup.threadWolves.length > 0)} />
					</div>,
					document.body,
				)}
		</>
	);
}
