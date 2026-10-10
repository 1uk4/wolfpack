/**
 * plan — read/write/validate the crawl plan. The plan is the determinism
 * contract between discovery and ingestion; the run gate (gatePlan) refuses
 * anything that does not match the structure.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWrite } from "@wolfpack/engine";
import {
  CrawlPlanSchema,
  type CrawlPlan,
  type SourceFile,
  type DatedFile,
  type Strategy,
  type Currency,
} from "./schemas.js";
import { globToRegExp, matchesAny, discoverSources, type DiscoverOptions } from "./discover.js";
import { resolveDates, isGitRepo } from "./dates.js";
import { buildPlan } from "./group.js";
import { createSink, type CrawlSink } from "./sink.js";

export function writePlan(path: string, plan: CrawlPlan): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWrite(path, yamlStringify(plan));
}

export function readPlan(path: string): CrawlPlan {
  const raw = yamlParse(readFileSync(path, "utf-8"));
  return CrawlPlanSchema.parse(raw);
}

/** Resolve a batch's globs against the discovered files (relative paths). */
export function resolveBatchFiles(
  batchGlobs: string[],
  files: SourceFile[]
): SourceFile[] {
  const res = batchGlobs.map(globToRegExp);
  return files.filter((f) => matchesAny(f.relPath, res));
}

export interface GateContext {
  /** Discovered source files (after include/exclude). */
  files: SourceFile[];
  /** Declared KB domains, or null when no registry is deployed. */
  declared: Set<string> | null;
  /** Whether the source root exists and is a directory. */
  sourceExists: boolean;
}

/**
 * The run gate. Returns an empty array when the plan may run, else the list of
 * specific failures. Pure — the caller supplies the IO-derived context.
 */
export function gatePlan(plan: CrawlPlan, ctx: GateContext): string[] {
  const fail: string[] = [];

  if (!ctx.sourceExists) fail.push(`source is not a directory: ${plan.source}`);
  if (plan.status !== "ready")
    fail.push(`status is "${plan.status}" — must be "ready" to run`);
  if (ctx.declared !== null && !ctx.declared.has(plan.domain))
    fail.push(`domain "${plan.domain}" is not declared in domains.yaml`);

  // Every batch resolves to >=1 file; no file claimed by two batches.
  const seen = new Map<string, string>();
  for (const b of plan.batches) {
    const matched = resolveBatchFiles(b.files, ctx.files);
    if (matched.length === 0)
      fail.push(`batch "${b.topic}" matches no files`);
    for (const f of matched) {
      const prior = seen.get(f.relPath);
      if (prior && prior !== b.topic)
        fail.push(
          `file ${f.relPath} claimed by two batches ("${prior}" and "${b.topic}")`
        );
      seen.set(f.relPath, b.topic);
    }
  }

  return fail;
}

/** Human-readable plan summary for review / --dry-run. */
export function renderPlanSummary(plan: CrawlPlan, files: SourceFile[]): string {
  const lines: string[] = [];
  let matched = 0;
  lines.push(
    `domain=${plan.domain} currency=${plan.currency} status=${plan.status}`
  );
  lines.push(`source=${plan.source}`);
  lines.push(`batches=${plan.batches.length} discovered=${files.length}`);
  lines.push("");
  for (const b of plan.batches) {
    const n = resolveBatchFiles(b.files, files).length;
    matched += n;
    const cur = b.currency ? ` currency=${b.currency}` : "";
    const date = b.date ? ` date=${b.date}` : "";
    lines.push(`  • ${b.topic} — ${n} file(s)${cur}${date}`);
  }
  lines.push("");
  lines.push(`matched=${matched} skipped=${files.length - matched}`);
  return lines.join("\n");
}

// ── plan (phase 1) ───────────────────────────────────────────────────────────
// Deterministic front end: discover → dates → group → plan, writing the full
// observability tree to the sink. No LLM, no KB writes.

export interface PlanCrawlOptions {
  source: string;
  domain: string;
  strategy: Strategy;
  currency?: Currency;
  /** by-folder: cap grouping key to N path segments. */
  folderDepth?: number;
  include?: string[];
  exclude?: string[];
  /** Override git usage (default: auto-detect a repo at source). */
  useGit?: boolean;
  /** Session id for the /tmp sink (default: crawl-<ts>). */
  sessionId?: string;
  /** Base dir for the sink (default: /tmp/wolfpack-crawl). */
  sinkBase?: string;
}

export interface PlanCrawlResult {
  plan: CrawlPlan;
  dated: DatedFile[];
  sink: CrawlSink;
}

/** Discover → dates → group → plan, writing the /tmp observability tree. */
export function planCrawl(opts: PlanCrawlOptions): PlanCrawlResult {
  const sessionId = opts.sessionId ?? `crawl-${Date.now()}`;
  const sink = createSink(sessionId, opts.sinkBase);
  sink.log(`plan start: source=${opts.source} domain=${opts.domain} strategy=${opts.strategy}`);

  const discoverOpts: DiscoverOptions = {
    include: opts.include,
    exclude: opts.exclude,
  };
  const files = discoverSources(opts.source, discoverOpts);
  sink.log(`discovered ${files.length} file(s)`);

  const useGit = opts.useGit ?? isGitRepo(opts.source);
  const dated = resolveDates(files, { useGit });
  sink.log(`resolved dates (git=${useGit})`);
  sink.file(
    "dates.json",
    JSON.stringify(
      dated.map((f) => ({ relPath: f.relPath, ...f.dateInfo })),
      null,
      2
    )
  );

  // Date-basis histogram for a quick confidence read.
  const hist: Record<string, number> = {};
  for (const f of dated) hist[f.dateInfo.basis] = (hist[f.dateInfo.basis] ?? 0) + 1;
  sink.log(`date basis: ${JSON.stringify(hist)}`);

  const plan = buildPlan(dated, {
    strategy: opts.strategy,
    domain: opts.domain,
    source: opts.source,
    currency: opts.currency,
    folderDepth: opts.folderDepth,
  });

  writePlan(join(sink.dir, "plan.yaml"), plan);
  const summary = renderPlanSummary(plan, files);
  sink.file("plan-summary.txt", summary);
  sink.log(`plan written: ${plan.batches.length} batch(es)`);
  sink.log(`\n${summary}`);

  return { plan, dated, sink };
}
