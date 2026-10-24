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
import { callCost, sumSteps } from "./prices.ts";
const ZERO_TOKENS = {
    inputTokens: undefined,
    outputTokens: undefined,
    cacheReadTokens: undefined,
    cacheWriteTokens: undefined,
    reasoningTokens: undefined,
};
const emptyStage = () => ({ dollars: 0, unpricedRuns: 0, runs: 0, tokens: { ...ZERO_TOKENS } });
/** One stage's dollars over its steps; null when the model is unpriced
 *  (all-or-nothing: a stage runs one model). */
function stageDollars(model, steps) {
    let total = 0;
    for (const step of steps) {
        const c = callCost(step, model);
        if (c === null)
            return null;
        total += c;
    }
    return total;
}
/** Merge one step-set's tokens into an accumulating CallUsage. */
function mergeTokens(into, steps) {
    const summed = sumSteps(steps);
    into.inputTokens = (into.inputTokens ?? 0) + (summed.inputTokens ?? 0);
    into.outputTokens = (into.outputTokens ?? 0) + (summed.outputTokens ?? 0);
    into.cacheReadTokens = (into.cacheReadTokens ?? 0) + (summed.cacheReadTokens ?? 0);
    into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + (summed.cacheWriteTokens ?? 0);
    into.reasoningTokens = (into.reasoningTokens ?? 0) + (summed.reasoningTokens ?? 0);
}
/** Fold every usage channel into the pill's payload. Pure: same input,
 *  same output — no clock, no fs, no store reads. */
export function graphCostSummary(input) {
    const extraction = emptyStage();
    const audit = emptyStage();
    const runs = [];
    const foldExtractionRun = (run, title) => {
        const stages = run.stages ?? { extractor: { model: "unknown", steps: [] }, auditor: { model: "unknown", steps: [] } };
        // Per-stage: tokens always count; dollars only when priced.
        extraction.runs++;
        mergeTokens(extraction.tokens, stages.extractor.steps);
        const extDollars = stageDollars(stages.extractor.model, stages.extractor.steps);
        if (extDollars === null)
            extraction.unpricedRuns++;
        else
            extraction.dollars += extDollars;
        audit.runs++;
        mergeTokens(audit.tokens, stages.auditor.steps);
        const audDollars = stageDollars(stages.auditor.model, stages.auditor.steps);
        if (audDollars === null)
            audit.unpricedRuns++;
        else
            audit.dollars += audDollars;
        // Run-level: null only when EVERY stage is unpriced.
        const allStages = [extDollars, audDollars];
        const runDollars = allStages.every((d) => d === null)
            ? null
            : allStages.reduce((a, d) => a + (d ?? 0), 0);
        const allSteps = [...stages.extractor.steps, ...stages.auditor.steps];
        runs.push({
            startedAt: run.startedAt,
            at: run.at,
            durationMs: run.durationMs,
            kind: "extraction",
            title,
            dollars: runDollars,
            tokens: sumSteps(allSteps),
            ...(run.stats ? { merged: run.stats } : {}),
        });
    };
    for (const chat of input.chats) {
        for (const run of chat.extractions)
            foldExtractionRun(run, chat.title);
    }
    for (const source of input.sources) {
        for (const run of source.extractions)
            foldExtractionRun(run, source.filePath);
    }
    runs.sort((a, b) => b.startedAt - a.startedAt);
    const capped = runs.slice(0, input.recentCap ?? 10);
    // A run is "unpriced" when it billed nothing countable at all.
    const unpricedRuns = runs.filter((r) => r.dollars === null).length;
    return {
        totalDollars: extraction.dollars + audit.dollars,
        unpricedRuns,
        stages: { extraction, audit },
        runs: capped,
    };
}
//# sourceMappingURL=cost-summary.js.map