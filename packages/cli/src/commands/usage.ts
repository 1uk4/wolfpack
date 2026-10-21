/**
 * wolfpack usage [wolf] [--since 7d|30d|24h|YYYY-MM-DD|all] [--by wolf|model|billing|source|day] [--json] [--no-ingest]
 * wolfpack usage ingest
 * wolfpack usage install-schedule | uninstall-schedule
 *
 * Totals model calls, tokens and cost for every wolf. Ingest copies new calls
 * from the logs on this machine — local wolves' pi session files, VPS wolves'
 * mirrored pi-durable stores, engine usage logs in each den — into the usage
 * ledger (~/.wolfpack/usage); the report reads only the ledger, so deleted
 * sessions never shrink history. Reading, ingest and grouping live in
 * ../usage/; this file only prints.
 */
import { loadConfig, LOCAL_HOST } from "../config.js";
import { c } from "../render.js";
import { aggregate, isGroupBy, parseSince, GROUP_BYS, type UsageReport, type UsageRow } from "../usage/aggregate.js";
import type { SourceReport } from "../usage/collect.js";
import { formatIngest, ingestUsage, type IngestResult } from "../usage/ingest.js";
import { defaultLedgerDir, readLedger } from "../usage/ledger.js";
import { installUsageSchedule, uninstallUsageSchedule } from "../usage-schedule.js";

export interface UsageOptions {
  since?: string;
  by?: string;
  json?: boolean;
  /** Report from the ledger as it stands, without ingesting first. */
  noIngest?: boolean;
  /** Ledger location (tests). */
  ledgerDir?: string;
}

/** 1234 → 1.2k, 1_234_567 → 1.2M. */
export function shortNumber(v: number): string {
  const abs = Math.abs(v);
  const fmt = (x: number, unit: string) => `${x >= 100 ? Math.round(x) : x.toFixed(1).replace(/\.0$/, "")}${unit}`;
  if (abs >= 1e9) return fmt(v / 1e9, "B");
  if (abs >= 1e6) return fmt(v / 1e6, "M");
  if (abs >= 1e3) return fmt(v / 1e3, "k");
  return String(v);
}

const usd = (v: number): string => `$${v.toFixed(2)}`;

const HEADERS = ["", "CALLS", "INPUT", "OUTPUT", "CACHE READ", "CACHE WRITE", "TOTAL", "API $", "NOTIONAL $", "OTHER $"];

function cells(r: UsageRow): string[] {
  return [
    r.key,
    String(r.calls),
    shortNumber(r.input),
    shortNumber(r.output),
    shortNumber(r.cacheRead),
    shortNumber(r.cacheWrite),
    shortNumber(r.totalTokens),
    usd(r.apiUsd),
    usd(r.notionalUsd),
    usd(r.otherUsd),
  ];
}

/** The report as a table: key column left-aligned, numbers right-aligned. */
export function formatReport(report: UsageReport): string {
  const headers = [report.by.toUpperCase(), ...HEADERS.slice(1)];
  const body = report.rows.map(cells);
  const total = cells(report.total);
  const widths = headers.map((h, i) => Math.max(h.length, total[i]!.length, ...body.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((s, i) => (i === 0 ? s.padEnd(widths[i]!) : s.padStart(widths[i]!))).join("  ");
  const rule = c.dim(widths.map((w) => "─".repeat(w)).join("  "));
  return [c.bold(line(headers)), ...body.map(line), rule, c.bold(line(total))].join("\n");
}

export function formatSources(s: SourceReport): string {
  const parts: string[] = [];
  const piFiles = Object.values(s.pi).reduce((a, b) => a + b, 0);
  const piWolves = Object.keys(s.pi);
  parts.push(`pi: ${piFiles} session file${piFiles === 1 ? "" : "s"}${piWolves.length ? ` (${piWolves.join(", ")})` : ""}`);
  parts.push(`durable: ${s.durable.length ? s.durable.join(", ") : "none"}`);
  parts.push(`engine: ${s.engineDens.length} den${s.engineDens.length === 1 ? "" : "s"}`);
  const lines = [parts.join(" · ")];
  for (const skip of s.skipped) lines.push(`skipped: ${skip}`);
  return lines.join("\n");
}

async function ingest(ledgerDir: string): Promise<IngestResult> {
  const config = loadConfig();
  return ingestUsage({
    wolvesRoot: config.wolvesRoot,
    hosts: Object.keys(config.hosts),
    localHost: LOCAL_HOST,
    ledgerDir,
  });
}

/**
 * Ingest new usage into the ledger as a side step of another command (launch,
 * sync) — the ledger stays current without a background job. Never fails or
 * delays the caller beyond the ingest itself (~0.3s when nothing changed).
 */
export async function ingestUsageQuietly(): Promise<void> {
  try {
    const r = await ingest(defaultLedgerDir());
    console.log(c.dim(`  ${formatIngest(r).split("\n")[0]}`));
  } catch (err) {
    console.log(c.dim(`  usage ingest skipped: ${err instanceof Error ? err.message : err}`));
  }
}

export async function usageCmd(arg: string | undefined, opts: UsageOptions): Promise<void> {
  const ledgerDir = opts.ledgerDir ?? defaultLedgerDir();
  switch (arg) {
    case "ingest": {
      const r = await ingest(ledgerDir);
      if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + "\n");
      else console.log(`${new Date().toISOString()} ${formatIngest(r)}`);
      return;
    }
    case "install-schedule":
      for (const note of installUsageSchedule()) console.log(`  ${note}`);
      return;
    case "uninstall-schedule":
      for (const note of uninstallUsageSchedule()) console.log(`  ${note}`);
      return;
  }
  const wolf = arg;
  const by = opts.by ?? "wolf";
  if (!isGroupBy(by)) throw new Error(`--by: expected one of ${GROUP_BYS.join(", ")}, got "${by}"`);
  const sinceArg = opts.since ?? "7d";
  const since = parseSince(sinceArg);

  const ingested = opts.noIngest ? undefined : await ingest(ledgerDir);
  const report = aggregate(readLedger(ledgerDir, since), by, { since, wolf });

  if (opts.json) {
    process.stdout.write(JSON.stringify({ ...report, ingest: ingested }, null, 2) + "\n");
    return;
  }

  const scope = wolf ? `${wolf}, ` : "";
  const window = since ? `since ${sinceArg} (${since.toLocaleString()})` : "all time";
  console.log(`\n  ${c.bold(`Model usage — ${scope}${window}, by ${by}`)}\n`);
  if (report.rows.length === 0) console.log("  No model calls in this window.");
  else console.log(formatReport(report).replace(/^/gm, "  "));
  const unpriced = report.total.unpriced;
  console.log();
  if (unpriced > 0) console.log(c.yellow(`  ${unpriced} call(s) unpriced (model not in the pi-ai catalog)`));
  if (ingested) {
    console.log(c.dim(`  ${formatIngest(ingested)}`));
    console.log(c.dim(formatSources(ingested.sources).replace(/^/gm, "  ")));
  } else {
    console.log(c.dim("  ledger only (--no-ingest)"));
  }
  console.log(c.dim(`  ledger: ${ledgerDir}`));
  console.log(c.dim("  API $ = metered spend · notional $ = API-equivalent of subscription calls") + "\n");
}
