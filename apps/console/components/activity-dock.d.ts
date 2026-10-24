import type { CallUsage, JobKind, JobRecord } from "@/src/core";
/**
 * THE BACKGROUND-AGENTS SECTION (owner, sidebar round — the successor of
 * the retired bottom-right floating dock): the bottom strip of the LEFT
 * SIDEBAR, one blob per running BACKGROUND process — session sub-agents
 * (research/demo/visual) and global extraction runs. Teaching turns are
 * deliberately NOT here: the section exists to give background processes
 * the observability the learner can't otherwise see; an in-flight teaching
 * turn is fully visible where it happens (user decision, 2026-09).
 *
 * Data: ONE feed of GET /api/activity (jobs across ALL chats, title-joined,
 * oldest-first + extraction runs), fetched when truth moves (events
 * channel, S5) and folded client-side with core/prices.ts.
 * Cost is INFERRED (jobCost); the context line is the LAST model call's
 * input+output against the model's limit (JobUsage.lastStep — pending
 * contract) — never a cumulative sum, which would be the wrong number.
 * Absent data renders "—", never zero (the doctrine).
 *
 * Quiet/ambient by design: no entry animations, stable keys, updates land
 * in place — refreshes never flicker. ALWAYS present (owner, sidebar round):
 * empty means EMPTY — the header sits alone, nothing hides; it populates and
 * GROWS when processes run (max-h + internal scroll so a pile never crowds
 * the session list). The sidebar's closed state means the learner opted
 * out — no ambient signal while closed (user decision: invisibility until
 * a clearer observability story wants building). Per blob: kind icon,
 * elapsed, cost, activity line, an explicit END button (POST
 * /api/activity/abort — the wave-4 backend is live): 404/409 mean the
 * process is already gone (refresh, no error); real failures degrade to
 * an inline "Abort failed", never a dead control. Detail (context, model,
 * steps, session link) EXPANDS INLINE — the section scrolls, so a
 * floating popover would clip at its bounds.
 */
/** JobUsage extended by the pending lastStep contract (the context line). */
interface FeedUsage extends NonNullable<JobRecord["usage"]> {
    lastStep?: CallUsage;
}
export interface FeedJob extends JobRecord {
    title: string;
    usage?: FeedUsage;
    /** Server-joined live catalog limit (owner amendment 2026-09-23) —
     *  null when the model is missing from pi's catalog (no context line). */
    contextLimit: number | null;
}
export interface FeedExtraction {
    /** Unique row id (source id, or "src#i" for chunk jobs). */
    id: string;
    chatId: string;
    part?: {
        i: number;
        n: number;
    };
    title: string;
    phase: string;
    startedAt: number;
}
export interface ActivityFeed {
    jobs: FeedJob[];
    extractions: FeedExtraction[];
}
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
export declare function ActivityProvider({ children }: {
    children: React.ReactNode;
}): any;
/** The activity feed seam for the rest of the shell: the dock's data +
 *  its refresh nudge. The remaining nudgers are client-visible causes
 *  (the extract/import buttons — extraction-coverage, graph-view); every
 *  server-side cause announces itself on the events channel now. */
export declare function useActivity(): {
    feed: ActivityFeed;
    refresh: () => void;
};
/** One dock blob: the unified view of a job or an extraction run. */
export interface ActivityBlob {
    /** job.id, or the extraction job's row id (source id, or "src#i" for
     *  chunk jobs — unique per row, per-chunk jobs owner 2026-09-28). */
    id: string;
    process: "job" | "extraction";
    /** Sub-agent kind for jobs (extraction blobs have none). */
    jobKind?: JobKind;
    /** Extraction phase (extracting/auditing/merging/embedding); jobs carry none. */
    phase?: string;
    title: string;
    chatId: string;
    /** ms epoch — blobs order oldest-first and elapsed counts from it. */
    startedAt: number;
    /** Inferred USD cost (jobCost) — null renders "—". */
    cost: number | null;
    /** Last model call's footprint vs the model's limit — null renders "—". */
    context: {
        used: number;
        limit: number;
    } | null;
    /** Latest human-readable activity line (""). */
    activity: string;
    /** Sub-agent model id, when usage is reported. */
    model?: string;
    /** Model calls made so far, when usage is reported. */
    steps?: number;
}
/** Merge the feed into one oldest-first blob list (the stable blob order). */
export declare function toBlobs(feed: ActivityFeed): ActivityBlob[];
/** Elapsed as a compact ticking string: 45s / 3m 04s / 1h 12m. */
export declare function formatElapsed(ms: number): string;
export declare function ActivitySection({ feed: feedProp }: {
    feed?: ActivityFeed;
}): any;
export {};
//# sourceMappingURL=activity-dock.d.ts.map