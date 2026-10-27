/**
 * pipeline — Dewey's pipeline read from the filesystem, for the console's pipeline view
 * (`GET /v1/wolves/:name/kb/pipeline`): inbox lanes, the newest receipts, parked items, the sweep in progress and
 * the last sweep. Read-only; it never opens an inbox contribution beyond its frontmatter.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";
import { readCurrent } from "./progress.js";
import { readLastSweep, type LastSweep } from "../shared/last-sweep.js";

export type PipelineOutcome = "create" | "merge" | "reject" | "parked" | "unclassified";

export interface PipelineLane {
  wolf: string;
  pending: number;
  oldestAgeMs?: number;
}
export interface PipelineReceipt {
  wolf: string;
  denTopicId: string;
  outcome: PipelineOutcome;
  entryId?: string;
  processed: string;
  detail?: string;
}
export interface PipelineParked {
  wolf: string;
  file: string;
  denTopicId?: string;
  reason?: string;
}
export interface Pipeline {
  lanes: PipelineLane[];
  receipts: PipelineReceipt[];
  parked: PipelineParked[];
  /** All parked items, of which `parked` lists the first PARKED_CAP. */
  parkedTotal: number;
  sweep: {
    current?: { from: string; denTopicId: string; startedAt: string; route?: string };
    last?: LastSweep;
  };
}

export const RECEIPT_CAP = 50;
export const PARKED_CAP = 100;

/** Receipts spell outcomes `create`/`merge`/`reject` (current) or `created`/`updated`/`merged`/`rejected` (older); one spelling out. */
export function normalizeOutcome(raw: string): PipelineOutcome | undefined {
  switch (raw.trim()) {
    case "create":
    case "created":
      return "create";
    case "merge":
    case "merged":
    case "updated":
      return "merge";
    case "reject":
    case "rejected":
      return "reject";
    case "parked":
      return "parked";
    case "unclassified":
      return "unclassified";
    default:
      return undefined;
  }
}

// Lanes are synced and written by other processes: a directory that vanishes or is unreadable reads as empty.
const dirs = (base: string): string[] => {
  try {
    return readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
};

const mdFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
};

function readLanes(roots: KbRoots, now: number): PipelineLane[] {
  const base = join(roots.opsRoot, "inbox");
  return dirs(base).map((wolf) => {
    // Top-level files only: `_processed/` and `_bad/` are directories.
    const files = mdFiles(join(base, wolf));
    let oldest = Infinity;
    for (const f of files) {
      try {
        oldest = Math.min(oldest, statSync(join(base, wolf, f)).mtimeMs);
      } catch {
        /* moved while listing */
      }
    }
    return { wolf, pending: files.length, ...(Number.isFinite(oldest) ? { oldestAgeMs: Math.max(0, Math.round(now - oldest)) } : {}) };
  });
}

// kb cannot import @wolfpack/memory's scanSecrets (memory depends on kb), so receipt text is redacted with the
// same conservative patterns here.
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
  /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{3,}(@)/gi,
  /(\b[A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|credential)s?["']?\s*[:=]\s*["']?)[^\s"'<>{}$,;]{8,}/gi,
];

/** First non-empty line, secrets redacted, whitespace collapsed, capped. */
export const oneLine = (s: string, max = 200): string => {
  let line = s.split("\n").find((l) => l.trim() !== "") ?? "";
  for (const re of SECRET_PATTERNS) line = line.replace(re, (m, a, b) => (a !== undefined && typeof a === "string" && a.length < m.length ? `${a}[REDACTED]${typeof b === "string" ? b : ""}` : "[REDACTED]"));
  line = line.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function readReceipts(roots: KbRoots): PipelineReceipt[] {
  const base = join(roots.opsRoot, "receipts");
  const files: { wolf: string; file: string; mtime: number }[] = [];
  for (const wolf of dirs(base)) {
    for (const file of mdFiles(join(base, wolf))) {
      try {
        files.push({ wolf, file, mtime: statSync(join(base, wolf, file)).mtimeMs });
      } catch {
        /* gone */
      }
    }
  }
  // Newest by mtime first; only those are opened.
  files.sort((a, b) => b.mtime - a.mtime);
  const out: PipelineReceipt[] = [];
  for (const f of files) {
    if (out.length >= RECEIPT_CAP) break;
    try {
      const { fields, body } = parseFrontmatter(readFileSync(join(base, f.wolf, f.file), "utf-8"));
      const outcome = normalizeOutcome(String(fields.outcome ?? ""));
      if (!outcome || !fields.den_topic_id) continue;
      const detail = oneLine(body);
      const processed = fields.processed ? String(fields.processed) : new Date(f.mtime).toISOString();
      const linked = outcome === "create" || outcome === "merge";
      out.push({
        wolf: f.wolf,
        denTopicId: String(fields.den_topic_id),
        outcome,
        ...(detail ? (linked ? { entryId: detail } : { detail }) : {}),
        processed,
      });
    } catch {
      /* unreadable receipt: skipped */
    }
  }
  return out.sort((a, b) => Date.parse(b.processed) - Date.parse(a.processed));
}

/** The reason a parked item was parked: from its own parked receipt (`<id>-<hash>.md` in the wolf's receipts), newest first. */
function parkedReason(roots: KbRoots, wolf: string, denTopicId: string): string | undefined {
  const dir = join(roots.opsRoot, "receipts", wolf);
  let best: { at: number; detail: string } | undefined;
  for (const f of mdFiles(dir)) {
    if (!f.startsWith(`${denTopicId}-`)) continue;
    try {
      const { fields, body } = parseFrontmatter(readFileSync(join(dir, f), "utf-8"));
      if (normalizeOutcome(String(fields.outcome ?? "")) !== "parked" || String(fields.den_topic_id ?? "") !== denTopicId) continue;
      const at = Date.parse(String(fields.processed ?? "")) || 0;
      if (!best || at >= best.at) best = { at, detail: oneLine(body) };
    } catch {
      /* unreadable receipt: skipped */
    }
  }
  // The receipt body ends with the unpark hint; the reason is what comes before it.
  return best?.detail.replace(/\.?\s*Re-run with:.*$/, "") || undefined;
}

function readParked(roots: KbRoots): { items: PipelineParked[]; total: number } {
  const base = join(roots.opsRoot, "parked");
  const all: { wolf: string; file: string }[] = [];
  for (const wolf of dirs(base)) for (const file of mdFiles(join(base, wolf)).sort()) all.push({ wolf, file });
  const items = all.slice(0, PARKED_CAP).map(({ wolf, file }): PipelineParked => {
    let denTopicId: string | undefined;
    try {
      const { fields } = parseFrontmatter(readFileSync(join(base, wolf, file), "utf-8"));
      if (fields.den_topic_id) denTopicId = String(fields.den_topic_id);
    } catch {
      /* unreadable: listed without a topic id */
    }
    const reason = denTopicId ? parkedReason(roots, wolf, denTopicId) : undefined;
    return { wolf, file, ...(denTopicId ? { denTopicId } : {}), ...(reason ? { reason } : {}) };
  });
  return { items, total: all.length };
}

export function readPipeline(roots: KbRoots, now = Date.now()): Pipeline {
  const receipts = readReceipts(roots);
  const parked = readParked(roots);
  const current = readCurrent(roots);
  const last = readLastSweep(roots);
  return {
    lanes: readLanes(roots, now),
    receipts,
    parked: parked.items,
    parkedTotal: parked.total,
    sweep: {
      ...(current ? { current: { from: current.from, denTopicId: current.denTopicId, startedAt: new Date(current.startedAt).toISOString(), ...(current.route ? { route: current.route } : {}) } } : {}),
      ...(last ? { last } : {}),
    },
  };
}
