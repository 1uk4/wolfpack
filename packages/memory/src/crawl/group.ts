/**
 * group — turn dated files into a CrawlPlan via a deterministic strategy, then
 * order batches chronologically (oldest→newest) so the journey reconstructs the
 * arc correctly. Pure: no filesystem, no side effects.
 */
import { dirname } from "node:path";
import type {
  DatedFile,
  CrawlPlan,
  Batch,
  Currency,
  Strategy,
} from "./schemas.js";
import { ordersJourney } from "./dates.js";

export interface BuildPlanOptions {
  strategy: Strategy;
  domain: string;
  source: string;
  currency?: Currency;
  /** by-folder only: cap the grouping key to N path segments (collapses facet
   *  subfolders like systems/auth/{api,logic,ux} into one "systems/auth" topic).
   *  Undefined = group by full directory (finest granularity). */
  folderDepth?: number;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "root";
}

/** by-folder: group by the file's directory, optionally capped to `depth`
 *  segments so facet subfolders collapse into their parent topic. */
function groupByFolder(
  files: DatedFile[],
  depth?: number
): Map<string, DatedFile[]> {
  const groups = new Map<string, DatedFile[]>();
  for (const f of files) {
    const dir = dirname(f.relPath);
    let key: string;
    if (dir === ".") {
      key = "root";
    } else if (depth && depth > 0) {
      key = dir.split("/").slice(0, depth).join("/");
    } else {
      key = dir;
    }
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  return groups;
}

/** Strip a leading date and trailing phase markers to get a feature stem. */
export function patternStem(relPath: string): string {
  let name = relPath.replace(/\.md$/i, "");
  // drop directory; pattern grouping is about the filename's feature
  name = name.split("/").pop() ?? name;
  // leading date: 2026-09-26- or 2026-09-
  name = name.replace(/^\d{4}-\d{2}(-\d{2})?[-_]?/, "");
  // trailing phase/version markers (repeatable): -plan-1, -phase-2, -design, -v3, -part-2
  let prev: string;
  do {
    prev = name;
    name = name.replace(
      /[-_](plan|phase|part|design|spec|v|rev)[-_]?\d*$/i,
      ""
    );
  } while (name !== prev);
  return slugify(name);
}

/** by-pattern: group by feature stem of the filename. */
function groupByPattern(files: DatedFile[]): Map<string, DatedFile[]> {
  const groups = new Map<string, DatedFile[]>();
  for (const f of files) {
    const key = patternStem(f.relPath);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(f);
  }
  return groups;
}

/** Earliest grounded (orderable) date among a batch's files, else undefined. */
export function batchDate(files: DatedFile[]): string | undefined {
  const dated = files
    .filter((f) => ordersJourney(f.dateInfo) && f.dateInfo.date)
    .map((f) => f.dateInfo.date!)
    .sort();
  return dated[0];
}

/** Sort comparator: grounded dates ascending; undated batches last, by name. */
function byChronology(
  a: { date?: string; topic: string },
  b: { date?: string; topic: string }
): number {
  if (a.date && b.date) return a.date.localeCompare(b.date) || a.topic.localeCompare(b.topic);
  if (a.date) return -1; // dated before undated
  if (b.date) return 1;
  return a.topic.localeCompare(b.topic);
}

export function buildPlan(
  files: DatedFile[],
  opts: BuildPlanOptions
): CrawlPlan {
  const groups =
    opts.strategy === "by-folder"
      ? groupByFolder(files, opts.folderDepth)
      : groupByPattern(files);

  const batches: Array<Batch & { _date?: string }> = [];
  for (const [key, groupFiles] of groups) {
    // Order files within a batch oldest→newest too (dated first, then by path).
    const sorted = [...groupFiles].sort((a, b) => {
      const da = ordersJourney(a.dateInfo) ? a.dateInfo.date : undefined;
      const db = ordersJourney(b.dateInfo) ? b.dateInfo.date : undefined;
      if (da && db) return da.localeCompare(db) || a.relPath.localeCompare(b.relPath);
      if (da) return -1;
      if (db) return 1;
      return a.relPath.localeCompare(b.relPath);
    });
    batches.push({
      topic: slugify(key),
      files: sorted.map((f) => f.relPath),
      _date: batchDate(sorted),
    });
  }

  batches.sort((a, b) => byChronology({ date: a._date, topic: a.topic }, { date: b._date, topic: b.topic }));

  return {
    domain: opts.domain,
    source: opts.source,
    currency: opts.currency ?? "archived",
    status: "draft",
    exclude: [],
    include: [],
    batches: batches.map(({ _date, ...b }) => b),
  };
}
