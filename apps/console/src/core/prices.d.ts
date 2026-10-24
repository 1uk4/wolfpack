/**
 * Price + context-limit registry — the money channel's lookup table (pure core).
 *
 * Every model the harness runs gets an entry: per-1M-token USD prices and
 * the model's context window. Usage is CAPTURED in the records (chat turns,
 * jobs); cost is INFERRED here at read time — nothing stores dollars, so a
 * price correction re-prices the whole history for free.
 *
 * The table is GENERATED, not hand-maintained: scripts/sync-pricing.ts pulls
 * OpenRouter's published per-token pricing and rewrites this file. Stale
 * prices are possible between syncs (they change rarely); a MISSING model
 * makes cost render as absent ("—"), never zero — the honest presentation.
 *
 * Client-safe: pure types + numbers, no node imports; exposed via the core
 * barrel (@/src/core) so shell components fold usage without cost math
 * living in components.
 */
import type { CallUsage, ChatRecord, JobRecord, TurnUsage } from "./contracts.ts";
/** Per-1M-token USD prices for one model. Fields absent where the provider
 *  doesn't bill them (cacheWrite is rare). */
export interface ModelPrice {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
}
/** Token prices, USD per 1M tokens. A missing model makes cost render
 *  as absent ("—"), never zero. Keys are uniformly provider-qualified
 *  ("provider:id") — NO legacy bare-slug compat (owner decision, sync
 *  script 2026-09-20): pre-wave records stamped with bare slugs render
 *  unpriced.
 *  Context-window limits are NOT a table (owner amendment, 2026-09-23):
 *  every meter's denominator reads pi's LIVE catalog (GET /api/models /
 *  the activity feed's server-side join) — missing model, usage-only.
 *  Refresh: bump @earendil-works/pi-ai, then npx tsx scripts/sync-pricing.ts
 *  (reads pi-ai's shipped catalogs — the same source the engine and the
 *  picker use). Forgetting the re-run is exactly how models go unpriced
 *  (deepseek-v4.1-flash, 2026-09-29) — the drift-guard test
 *  (tests/prices-sync.test.ts) fails the gates until you do. */
export declare const PRICES: Record<string, ModelPrice>;
/** Sum a list of per-step usages into one CallUsage. A field stays
 *  undefined when EVERY step left it unreported — absent is not zero. */
export declare function sumSteps(steps: readonly CallUsage[]): CallUsage;
/** One model call's inferred cost in USD — null when the model is unknown
 *  or the usage fields are absent (never guess a price). Cached input bills
 *  at the cache-read rate; cache writes bill separately where priced. */
export declare function callCost(usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}, model: string): number | null;
/** One turn's inferred cost — the sum over its steps; null when unpriceable. */
export declare function turnCost(turn: TurnUsage): number | null;
/** Fold a chat record's turn log: total inferred session cost. Unknown-model
 *  or partial-usage turns don't poison the total — they count as unpriced
 *  and are reported alongside, so the UI can show "n turns unpriced". */
export declare function sessionCost(record: Pick<ChatRecord, "turns">): {
    cost: number;
    unpriced: number;
};
/** The session's context-window footprint: the LAST model call's
 *  token footprint against the model's limit (the next turn re-sends
 *  the whole conversation — the last call's input IS the running
 *  transcript size). Null when the record has no usage yet or the
 *  model's limit is unknown.
 *
 *  NUMERATOR (owner audit, 2026-09-23): cache tokens count. Provider
 *  `input` EXCLUDES cacheRead/cacheWrite, so folding input+output alone
 *  reads wildly low on cache-heavy sessions — include all four
 *  (= pi's own totalTokens semantics; the fields are persisted in every
 *  CallUsage).
 *
 *  DENOMINATOR (owner ruling, 2026-09-23 — the amendment): the live
 *  catalog is the ONLY source — `limits`, when given, is the index of
 *  provider:id → contextWindow straight from pi's catalog (GET
 *  /api/models serves it per model; the server's catalogContextLimits
 *  builds the same index). No hardcoded fallback: a model missing from
 *  the live index (historical session, package update removed it, a
 *  failed catalog fetch) resolves limit null and the meter renders
 *  usage-only — the honest-render precedent (never a fake window,
 *  same shape as unpriced models never showing $0).
 *
 *  Zeroed-step fallback: an aborted/failed last call reports zeroed
 *  usage — that is NOT the session footprint; fall back to the previous
 *  step's usage (the honest last-known footprint, never a bogus tiny
 *  meter). */
export declare function contextWindow(record: Pick<ChatRecord, "turns">, limits?: ReadonlyMap<string, number>): {
    model: string;
    usedTokens: number;
    limit: number | null;
} | null;
/** A job's inferred cost — null until the runner's capture lands / for
 *  unknown models (render "—", never zero). */
export declare function jobCost(job: Pick<JobRecord, "usage">): number | null;
//# sourceMappingURL=prices.d.ts.map