/**
 * Usage aggregation — events in, grouped rows out. Pure, so a dashboard can
 * reuse it on the same events the CLI prints.
 */
import type { UsageEvent } from "@wolfpack/engine";

export const GROUP_BYS = ["wolf", "model", "billing", "source", "use", "day"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export function isGroupBy(v: unknown): v is GroupBy {
  return typeof v === "string" && (GROUP_BYS as readonly string[]).includes(v);
}

export interface UsageRow {
  key: string;
  calls: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  /** Real spend on metered keys (billing api, reported or computed). */
  apiUsd: number;
  /** API-equivalent of subscription calls. */
  notionalUsd: number;
  /** Spend on any other billing (openrouter, openai, …). */
  otherUsd: number;
  /** Calls with no cost (model not in the catalog). */
  unpriced: number;
}

export interface UsageReport {
  by: GroupBy;
  since?: string;
  rows: UsageRow[];
  total: UsageRow;
}

/**
 * Parse --since: `<n>h`, `<n>d`, `YYYY-MM-DD` (local midnight) or `all`
 * (undefined: no lower bound). Throws on anything else.
 */
export function parseSince(v: string, now: Date = new Date()): Date | undefined {
  if (v === "all") return undefined;
  const rel = v.match(/^(\d+)([hd])$/);
  if (rel) {
    const hours = Number(rel[1]) * (rel[2] === "d" ? 24 : 1);
    return new Date(now.getTime() - hours * 3_600_000);
  }
  const day = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (day) {
    const d = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    if (!Number.isNaN(d.getTime()) && d.getDate() === Number(day[3])) return d;
  }
  throw new Error(`--since: expected 24h, 7d, 30d, YYYY-MM-DD or all, got "${v}"`);
}

/** Local calendar day of an ISO timestamp. */
export function localDay(ts: string): string {
  const d = new Date(ts);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function keyOf(e: UsageEvent, by: GroupBy): string {
  switch (by) {
    case "wolf":
      return e.wolf;
    case "model":
      return e.model;
    case "billing":
      return e.billing;
    case "source":
      return e.source;
    case "use":
      return e.use;
    case "day":
      return localDay(e.ts);
  }
}

function emptyRow(key: string): UsageRow {
  return {
    key,
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    apiUsd: 0,
    notionalUsd: 0,
    otherUsd: 0,
    unpriced: 0,
  };
}

function add(row: UsageRow, e: UsageEvent): void {
  row.calls++;
  row.input += e.input;
  row.output += e.output;
  row.cacheRead += e.cacheRead;
  row.cacheWrite += e.cacheWrite;
  row.totalTokens += e.input + e.output + e.cacheRead + e.cacheWrite;
  if (e.costUsd === undefined || e.costSource === "unknown") {
    row.unpriced++;
    return;
  }
  if (e.billing === "api") row.apiUsd += e.costUsd;
  else if (e.billing === "subscription") row.notionalUsd += e.costUsd;
  else row.otherUsd += e.costUsd;
}

export interface Filter {
  since?: Date;
  wolf?: string;
}

/** Keep events at/after `since` and for `wolf`. */
export function filterEvents(events: UsageEvent[], f: Filter): UsageEvent[] {
  const since = f.since?.getTime();
  return events.filter((e) => (since === undefined || Date.parse(e.ts) >= since) && (!f.wolf || e.wolf === f.wolf));
}

/** Group events. Rows sort by total tokens, descending — except days, which run oldest first. */
export function aggregate(events: UsageEvent[], by: GroupBy, f: Filter = {}): UsageReport {
  const groups = new Map<string, UsageRow>();
  const total = emptyRow("TOTAL");
  for (const e of filterEvents(events, f)) {
    const key = keyOf(e, by);
    let row = groups.get(key);
    if (!row) groups.set(key, (row = emptyRow(key)));
    add(row, e);
    add(total, e);
  }
  const rows = [...groups.values()].sort((a, b) =>
    by === "day" ? a.key.localeCompare(b.key) : b.totalTokens - a.totalTokens || a.key.localeCompare(b.key),
  );
  return { by, since: f.since?.toISOString(), rows, total };
}
