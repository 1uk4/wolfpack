/**
 * dates — recover each document's date via a confidence-tiered trust chain.
 *
 * The journey depends on chronological ORDER, so ordering is only ever done by
 * dates we can ground. We NEVER fabricate: filesystem mtime (unreliable on synced
 * vaults — it is the copy date) is recorded but never used to order, and when
 * nothing resolves the file is left `none` (undated) for the consolidator to place
 * by content. A confidently-wrong date corrupts the arc — wrong is worse than
 * unknown. (In-content dates are recovered later, by the observer; see spec §7.)
 */
import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, basename } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import type { SourceFile, DatedFile, DateInfo } from "./schemas.js";

export interface ResolveDateOptions {
  /** When true, consult git for the authored date (survives copies/syncs). */
  useGit?: boolean;
  /** Human-pinned date (plan mode) — treated as the highest-confidence source. */
  pinned?: string;
}

const ISO_DAY = /^(\d{4}-\d{2}-\d{2})/;
const ISO_MONTH = /^(\d{4}-\d{2})/;
const ISO_YEAR = /^(\d{4})/;

/** Normalize any grounded date string to the finest ISO form it supports. */
export function normalizeDate(raw: string): string | undefined {
  const s = raw.trim();
  const d = ISO_DAY.exec(s);
  if (d) return d[1];
  const m = ISO_MONTH.exec(s);
  if (m) return m[1];
  const y = ISO_YEAR.exec(s);
  if (y) return y[1];
  return undefined;
}

/** Leading YYYY-MM-DD (or YYYY-MM) in a filename, e.g. degen's plan files. */
export function dateFromFilename(name: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2}|\d{4}-\d{2})/.exec(basename(name));
  return m ? m[1] : undefined;
}

/** Explicit date in YAML frontmatter: prefer `updated`, then `date`, `created`. */
export function dateFromFrontmatter(absPath: string): string | undefined {
  try {
    const { fields } = parseFrontmatter(readFileSync(absPath, "utf-8"));
    for (const key of ["updated", "date", "created"]) {
      const v = fields[key];
      if (v != null && String(v).trim() && String(v) !== "null") {
        const n = normalizeDate(String(v));
        if (n) return n;
      }
    }
  } catch {
    /* unreadable / no frontmatter */
  }
  return undefined;
}

/** git authored date of the last commit touching this file (ISO day). */
export function dateFromGit(absPath: string): string | undefined {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%ad", "--date=short", "--", basename(absPath)],
      { cwd: dirname(absPath), encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    return out ? normalizeDate(out) : undefined;
  } catch {
    return undefined;
  }
}

function mtimeDay(absPath: string): string | undefined {
  try {
    return statSync(absPath).mtime.toISOString().slice(0, 10);
  } catch {
    return undefined;
  }
}

/**
 * Resolve a file's date + confidence. Order of trust:
 *   pinned(high) → frontmatter(high) → git(high) → filename(high) → mtime(low)
 * mtime is low-confidence and will NOT be used for ordering upstream.
 */
export function resolveDate(
  file: SourceFile,
  opts: ResolveDateOptions = {}
): DateInfo {
  if (opts.pinned) {
    const n = normalizeDate(opts.pinned);
    if (n) return { date: n, basis: "frontmatter", confidence: "high" };
  }

  const fm = dateFromFrontmatter(file.absPath);
  if (fm) return { date: fm, basis: "frontmatter", confidence: "high" };

  if (opts.useGit) {
    const g = dateFromGit(file.absPath);
    if (g) return { date: g, basis: "git", confidence: "high" };
  }

  const fn = dateFromFilename(file.relPath);
  if (fn) return { date: fn, basis: "filename", confidence: "high" };

  const mt = mtimeDay(file.absPath);
  if (mt) return { date: mt, basis: "mtime", confidence: "low" };

  return { basis: "none", confidence: "none" };
}

/** True if a git repo contains this path (cheap check for the whole crawl). */
export function isGitRepo(root: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Only high/medium-confidence dates may order the journey. */
export function ordersJourney(info: DateInfo): boolean {
  return info.confidence === "high" || info.confidence === "medium";
}

/** Resolve dates for a batch of files (deterministic; one git check per crawl). */
export function resolveDates(
  files: SourceFile[],
  opts: ResolveDateOptions = {}
): DatedFile[] {
  return files.map((f) => ({ ...f, dateInfo: resolveDate(f, opts) }));
}
