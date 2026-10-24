/**
 * Graph-pipeline cost summary (2026-09 graph cost metrics wave) — the pure
 * fold behind the graph view's cost pill. Two usage channels in: chat
 * extraction runs (ChatRecord.extractions) and notes-source runs
 * (NotesSource.extractions). Out: per-stage totals (extraction / audit)
 * + a capped recent-runs list. (The cluster-naming channel died with the
 * extraction-UX close-out, 2026-09-24 — UI's displayCostTotals had already
 * dropped it; historical naming-runs.jsonl spend is simply not displayed,
 * the same ruling as wave 7's stages.embedding.)
 *
 * MONEY CHANNEL LAW: dollars are INFERRED here at read time via
 * core/prices.ts — never stored anywhere. An unpriced model contributes
 * ZERO dollars but is counted in `unpricedRuns` so the UI can render
 * "— unpriced" honestly, never a silent zero. Tokens always sum.
 *
 * Client-safe: pure types + math, no node imports; exposed via the core
 * barrel so the pill/panel components carry no cost math.
 */
import type { CallUsage, EmissionStats, ExtractionRunUsage } from "./contracts.ts";
/** One pipeline stage's cumulative cost across every run. */
export interface StageCost {
    /** Inferred USD summed over PRICED runs (partial when unpricedRuns > 0). */
    dollars: number;
    /** Stage-runs whose model is missing from PRICES (render "—", never zero). */
    unpricedRuns: number;
    /** Runs that billed this stage. */
    runs: number;
    /** Token totals across every run. */
    tokens: CallUsage;
}
/** One run in the recent-runs list (extraction or naming). */
export interface RecentRun {
    startedAt: number;
    /** ISO wall-clock. */
    at: string;
    durationMs: number;
    /** "extraction" covers both front doors (chat + notes). */
    kind: "extraction";
    /** Chat title / source file path / fixed label for naming runs. */
    title: string;
    /** Whole-run inferred USD; null only when EVERY stage is unpriced. */
    dollars: number | null;
    tokens: CallUsage;
    /** What the run merged into the graph; absent on failed runs. */
    merged?: EmissionStats;
}
/** The cost pill's whole payload: stage totals + recent runs. */
export interface GraphCostSummary {
    /** Inferred USD across all priced stages of all runs. */
    totalDollars: number;
    /** Runs where EVERY stage was unpriced (totalDollars excludes them). */
    unpricedRuns: number;
    /** The billable pipeline stages. (Wave 7, owner ruling 2026-09-23:
     *  the embedding stage is gone with the provider embedder; the
     *  2026-09-24 close-out culled cluster naming the same way —
     *  historical spend on either is simply not displayed.) */
    stages: {
        extraction: StageCost;
        audit: StageCost;
    };
    /** Newest first, capped at `recentCap` (default 10). */
    runs: RecentRun[];
}
/** What the fold reads: already-collected run records, front-door-tagged. */
export interface CostSummaryInput {
    /** Chat-front-door runs: chat title + the record's usage log. */
    chats: {
        title: string;
        extractions: ExtractionRunUsage[];
    }[];
    /** Notes-front-door runs: imported file path + the source's usage log. */
    sources: {
        filePath: string;
        extractions: ExtractionRunUsage[];
    }[];
    recentCap?: number;
}
/** Fold every usage channel into the pill's payload. Pure: same input,
 *  same output — no clock, no fs, no store reads. */
export declare function graphCostSummary(input: CostSummaryInput): GraphCostSummary;
//# sourceMappingURL=cost-summary.d.ts.map