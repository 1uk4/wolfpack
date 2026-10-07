/**
 * plan — read/write/validate the crawl plan. The plan is the determinism
 * contract between discovery and ingestion; the run gate (gatePlan) refuses
 * anything that does not match the structure.
 */
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parse as yamlParse, stringify as yamlStringify } from "yaml";
import { atomicWrite } from "@wolfpack/engine";
import { CrawlPlanSchema, type CrawlPlan, type SourceFile } from "./schemas.js";
import { globToRegExp, matchesAny } from "./discover.js";

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
