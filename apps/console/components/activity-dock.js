"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIcon, BotIcon, FileTextIcon, PenToolIcon, PlayIcon, SearchIcon, SquareIcon, WaypointsIcon } from "lucide-react";
import { isModelsRefusal, isProviderKeyRefusal, jobCost } from "@/src/core";
import { formatTokens, formatUsd } from "@/components/usage-format";
import { useServerEvent, useServerResync } from "@/components/server-events";
const EMPTY_FEED = { jobs: [], extractions: [] };
// ─── The activity feed (composition root: the root layout) ───────────────────
const ActivityContext = createContext({
    feed: EMPTY_FEED,
    refresh: () => { },
});
/**
 * THE ACTIVITY FEED, PUSH-DRIVEN (architecture S5, 2026-10-02): the
 * adaptive poll is RETIRED — the dock refetches exactly when truth moves.
 * Every cause is announced on the events channel: extraction phase
 * transitions (activity-changed), job writes
 * (jobs-changed — the running-jobs blobs), and channel resync (reconnect /
 * dev-restart catch-up) — plus the one client-local cause that predates
 * the channel: visibility, a tab becoming visible refetches at once.
 * Announced fetches ride a 250ms trailing debounce (extraction phase
 * bursts); resync and visibility are immediate. A failed
 * fetch keeps the last feed (the dock never flickers to empty on a blip).
 */
export function ActivityProvider({ children }) {
    const [feed, setFeed] = useState(EMPTY_FEED);
    const [nonce, setNonce] = useState(0);
    const refresh = useCallback(() => setNonce((n) => n + 1), []);
    const refreshRef = useRef(refresh);
    refreshRef.current = refresh;
    const debounceRef = useRef(undefined);
    useEffect(() => {
        let alive = true;
        void (async () => {
            try {
                const res = await fetch("/api/activity");
                if (res.ok) {
                    const data = (await res.json());
                    if (alive)
                        setFeed({ jobs: data.jobs ?? [], extractions: data.extractions ?? [] });
                }
            }
            catch {
                // transport blip: keep the last feed, announce again next event
            }
        })();
        return () => {
            alive = false;
        };
    }, [nonce]);
    // Announcements → one trailing fetch per burst (the S4 debounce law).
    const scheduleAnnouncedFetch = () => {
        if (debounceRef.current)
            clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            debounceRef.current = undefined;
            refreshRef.current();
        }, 250);
    };
    useServerEvent("activity-changed", scheduleAnnouncedFetch);
    useServerEvent("jobs-changed", scheduleAnnouncedFetch);
    // Reconnect catch-up: events missed while the channel was down.
    useServerResync(() => refreshRef.current());
    // The visibility nudge: returning to the tab refetches immediately —
    // anything missed while hidden lands at once.
    useEffect(() => {
        const onVisibility = () => {
            if (document.visibilityState === "visible")
                setNonce((n) => n + 1);
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => document.removeEventListener("visibilitychange", onVisibility);
    }, []);
    // The debounce timer never outlives the provider.
    useEffect(() => () => {
        if (debounceRef.current)
            clearTimeout(debounceRef.current);
    }, []);
    return <ActivityContext.Provider value={{ feed, refresh }}>{children}</ActivityContext.Provider>;
}
/** The activity feed seam for the rest of the shell: the dock's data +
 *  its refresh nudge. The remaining nudgers are client-visible causes
 *  (the extract/import buttons — extraction-coverage, graph-view); every
 *  server-side cause announces itself on the events channel now. */
export function useActivity() {
    return useContext(ActivityContext);
}
/** Merge the feed into one oldest-first blob list (the stable blob order). */
export function toBlobs(feed) {
    const blobs = feed.jobs.map((job) => {
        const usage = job.usage;
        let context = null;
        const lastStep = usage?.lastStep;
        // Context-meter amendment (owner 2026-09-23): the limit comes off
        // the FEED (server-joined from pi's live catalog) — no client-side
        // table. Null limit = no context line (usage-only render is the
        // blob shape's call — here the line simply hides).
        const limit = job.contextLimit;
        if (usage && lastStep && limit !== null && lastStep.inputTokens !== undefined) {
            // Same metric as the session meter (prices.ts stepFootprint — the
            // context-meter audit, owner 2026-09-23): all four directions.
            // Provider "input" EXCLUDES cacheRead/cacheWrite, so input+output
            // alone reads wildly low on cache-heavy jobs.
            context = {
                used: lastStep.inputTokens +
                    (lastStep.outputTokens ?? 0) +
                    (lastStep.cacheReadTokens ?? 0) +
                    (lastStep.cacheWriteTokens ?? 0),
                limit,
            };
        }
        return {
            id: job.id,
            process: "job",
            jobKind: job.kind,
            title: job.title,
            chatId: job.chatId,
            startedAt: Date.parse(job.createdAt) || 0,
            cost: jobCost(job),
            context,
            // BYOK (owner, 2026-09-22): a refusal is info, not failure —
            // the honest line the runner left ("failed") reads as setup
            // needed, matching the dispatch card's quiet tone. The
            // provider-key refusal twin (zero-keys wave, Platform's
            // 66dbea9): a pinned model whose key is gone reads as the key
            // being needed, same quiet tone.
            activity: isModelsRefusal(job.error)
                ? "needs model setup"
                : isProviderKeyRefusal(job.error)
                    ? "needs a provider key"
                    : (job.activity ?? ""),
            model: usage?.model,
            steps: usage?.steps,
        };
    });
    for (const run of feed.extractions) {
        blobs.push({
            id: run.id,
            process: "extraction",
            phase: run.phase,
            title: run.title,
            chatId: run.chatId,
            startedAt: run.startedAt,
            cost: null, // extraction runs don't ride the money channel (v1)
            context: null,
            activity: "",
        });
    }
    blobs.sort((a, b) => a.startedAt - b.startedAt);
    return blobs;
}
/** Elapsed as a compact ticking string: 45s / 3m 04s / 1h 12m. */
export function formatElapsed(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
// ─── The section (the sidebar's bottom strip) ─────────────────────────────────
/** A 1s heartbeat while the section is populated — elapsed lines tick. */
function useNow(active) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active)
            return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [active]);
    return now;
}
const KIND_ICON = {
    research: SearchIcon,
    demo: PlayIcon,
    visual: PenToolIcon,
    pdf: FileTextIcon, // sources v0 — type-forced entry (JobKind grew "pdf")
};
export function ActivitySection({ feed: feedProp }) {
    const ctx = useContext(ActivityContext);
    const feed = feedProp ?? ctx.feed;
    const refresh = ctx.refresh;
    const blobs = useMemo(() => toBlobs(feed), [feed]);
    const [openBlob, setOpenBlob] = useState(null); // detail, inline-expanded
    const [abortStates, setAbortStates] = useState({});
    const now = useNow(blobs.length > 0);
    // Refs for stable abort handlers (no re-created closures per tick).
    const abortRef = useRef({ blobs, refresh, setAbortStates });
    abortRef.current = { blobs, refresh, setAbortStates };
    const totalCost = useMemo(() => {
        const priced = blobs.map((b) => b.cost).filter((c) => c !== null);
        return priced.length === 0 ? null : priced.reduce((a, c) => a + c, 0);
    }, [blobs]);
    const abort = useCallback(async (blob) => {
        const { setAbortStates: set } = abortRef.current;
        set((s) => ({ ...s, [blob.id]: "pending" }));
        try {
            const res = await fetch("/api/activity/abort", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    kind: blob.process,
                    // Extractions abort by SOURCE id (chatId) — chunk rows share one
                    // source and die together.
                    id: blob.process === "extraction" ? blob.chatId : blob.id,
                }),
            });
            if (!res.ok) {
                // 404 not_found / 409 not_running: the process is already gone —
                // the desired end state. Refresh and clear; nothing to report.
                if (res.status === 404 || res.status === 409) {
                    abortRef.current.refresh();
                    set((s) => {
                        const { [blob.id]: _drop, ...rest } = s;
                        return rest;
                    });
                    return;
                }
                throw new Error(String(res.status));
            }
            abortRef.current.refresh();
        }
        catch {
            set((s) => ({ ...s, [blob.id]: "failed" }));
        }
    }, []);
    // Sidebar-native skin (owner, sidebar round): part of the sidebar's
    // surface, not a floating card — the border-t separator matches the
    // sidebar's own edge line, the header matches the "Sessions" label, the
    // rows match the session rows' hover. Empty means empty: the header sits
    // alone (the cost span is population, not decoration).
    return (<section data-testid="activity-section" className="border-t border-border px-3 pb-3 pt-2">
			<div className="mb-1 flex items-center gap-1.5 text-xs uppercase tracking-widest text-muted-foreground/70">
				<ActivityIcon className="size-3"/>
				Background agents
				{blobs.length > 0 && (<span className="ml-auto tabular-nums" data-testid="activity-total-cost" title="Total running cost (inferred)">
						{totalCost === null ? "—" : formatUsd(totalCost)}
				</span>)}
			</div>
			{blobs.length > 0 && (<div className="flex max-h-[40dvh] flex-col gap-1 overflow-y-auto">
					{blobs.map((blob) => (<ActivityBlobRow key={blob.id} blob={blob} now={now} detailOpen={openBlob === blob.id} onToggleDetail={() => setOpenBlob((id) => (id === blob.id ? null : blob.id))} abortState={abortStates[blob.id]} onAbort={() => void abort(blob)}/>))}
			</div>)}
		</section>);
}
/** One blob: icon + elapsed + cost on the face; click → detail popover. */
function ActivityBlobRow({ blob, now, detailOpen, onToggleDetail, abortState, onAbort, }) {
    const Icon = blob.process === "extraction" ? WaypointsIcon : (blob.jobKind && KIND_ICON[blob.jobKind]) || BotIcon;
    const label = blob.process === "extraction"
        ? `Extraction — ${blob.phase ?? "running"}`
        : blob.jobKind === "research"
            ? "Researcher"
            : blob.jobKind === "demo"
                ? "Demo builder"
                : blob.jobKind === "visual"
                    ? "Figure maker"
                    : blob.jobKind === "pdf"
                        ? "PDF reader"
                        : "Sub-agent";
    return (<div data-testid={`activity-blob-${blob.process}`} className="relative rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-accent">
			<button type="button" onClick={onToggleDetail} aria-expanded={detailOpen} className="flex w-full items-center gap-2 pr-7 text-left">
				<Icon className="size-3.5 shrink-0 text-muted-foreground"/>
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-card-foreground">{blob.title}</span>
					{blob.activity ? (<span className="block truncate text-muted-foreground" title={blob.activity}>
							{blob.activity}
						</span>) : (<span className="block truncate text-muted-foreground/80">{label}</span>)}
				</span>
				<span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
					<span data-testid="activity-blob-cost">{blob.cost === null ? "—" : formatUsd(blob.cost)}</span>
					<span data-testid="activity-blob-elapsed">{formatElapsed(now - blob.startedAt)}</span>
				</span>
			</button>
			{/* The explicit END always on the blob's face (SCOPE) — the popover
            is for DETAIL, not the control. A failed abort locks the button and
            says why; a succeeded one just makes the blob vanish on refresh. */}
			<button type="button" data-testid="activity-abort" onClick={onAbort} disabled={abortState !== undefined} title={abortState === "failed" ? "Abort failed — try again" : "End this background process"} aria-label={`End ${label} in ${blob.title}`} className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50">
				<SquareIcon className="size-3"/>
			</button>

			{detailOpen && (<div data-testid="activity-blob-detail" className="mt-1 flex flex-col gap-1 rounded-lg bg-accent/40 p-2 text-muted-foreground">
					<div className="mb-1.5 flex items-center gap-2">
						<Icon className="size-3.5 text-muted-foreground"/>
						<span className="font-medium">{label}</span>
						<span className="ml-auto tabular-nums text-muted-foreground">
							{formatElapsed(now - blob.startedAt)}
						</span>
					</div>
					<div className="flex flex-col gap-1 text-muted-foreground">
						<div className="truncate text-card-foreground" title={blob.title}>
							{blob.title}
						</div>
						{blob.activity && <div className="break-words">{blob.activity}</div>}
						<div className="flex justify-between gap-2">
							<span>Cost</span>
							<span className="tabular-nums text-card-foreground">
								{blob.cost === null ? "—" : formatUsd(blob.cost)}
							</span>
						</div>
						<div className="flex justify-between gap-2">
							<span>Context</span>
							<span className="tabular-nums text-card-foreground" data-testid="activity-blob-context">
								{blob.context === null
                ? "—"
                : `${formatTokens(blob.context.used)} / ${formatTokens(blob.context.limit)}`}
							</span>
						</div>
						{blob.model && (<div className="flex justify-between gap-2">
								<span>Model</span>
								<span className="truncate text-card-foreground">{blob.model}</span>
							</div>)}
						{blob.steps !== undefined && (<div className="flex justify-between gap-2">
								<span>Steps</span>
								<span className="tabular-nums text-card-foreground">{blob.steps}</span>
							</div>)}
						<a href={`/chat/${blob.chatId}`} className="text-primary hover:underline">
							Open session →
						</a>
					</div>
					<div className="mt-2 text-muted-foreground/80">
					{abortState === "failed" && "Abort failed — try again"}
					{abortState === "pending" && "Stopping…"}
				</div>
				</div>)}
		</div>);
}
//# sourceMappingURL=activity-dock.js.map