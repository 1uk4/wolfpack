/**
 * Activity counters per wolf (GET /v1/activity/stats): accepted, rejected by reason, rate-limited, derived-published and
 * queue-dropped. In memory, O(1) per call, never throws. Bounded: at most `maxWolves` rows; wolves past that are folded into one
 * overflow row ("_other") so the totals stay right. Reasons are a fixed set, so a row's size is fixed too.
 */
import { ACTIVITY_VERSION, type ActivityStats } from "@wolfpack/protocol";

export const STATS_MAX_WOLVES = 200;
export const STATS_OVERFLOW = "_other";
export type StatsReason = "invalid" | "spoofed";
type Row = ActivityStats["wolves"][string];
const blank = (): Row => ({ accepted: 0, rejected: {}, rateLimited: 0, derivedPublished: 0, queueDropped: 0 });

export function createActivityStats(opts: { maxWolves?: number } = {}) {
  const max = opts.maxWolves ?? STATS_MAX_WOLVES;
  const rows = new Map<string, Row>();
  const row = (name: string): Row => {
    const key = name.slice(0, 64) || "?";
    let r = rows.get(key);
    if (r) return r;
    if (rows.size >= max - 1 && key !== STATS_OVERFLOW) return row(STATS_OVERFLOW);
    r = blank();
    rows.set(key, r);
    return r;
  };
  return {
    add(wolf: string, field: "accepted" | "rateLimited" | "derivedPublished" | "queueDropped", n = 1): void {
      try { row(wolf)[field] += n; } catch { /* counters never fail a caller */ }
    },
    reject(wolf: string, reason: StatsReason, n = 1): void {
      try { const r = row(wolf); r.rejected[reason] = (r.rejected[reason] ?? 0) + n; } catch { /* ignore */ }
    },
    snapshot(pack: string, at: number): ActivityStats {
      return { v: ACTIVITY_VERSION, pack, at, wolves: Object.fromEntries(rows) };
    },
    get size(): number { return rows.size; },
  };
}
export type ActivityStatsStore = ReturnType<typeof createActivityStats>;
