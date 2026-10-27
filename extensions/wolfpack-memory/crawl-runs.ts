/**
 * Crawl runs on disk and in flight, shared by the durable crawl run/release tools (unified-crawl-run.ts).
 *
 * Pure of pi / harness imports. The lifecycle of a run dir is derived from which files exist (plan → incomplete →
 * complete → released → curated), exactly as the pi commands (/wolf:crawls, /wolf:crawl-run, /wolf:crawl-release) read it.
 * NOTE: index.ts still carries its own copies of the disk readers; they read the same files the same way.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readPlan, type CrawlBatchStage, type CrawlProgress, type CrawlUsageStats } from "@wolfpack/memory";

// ── disk lifecycle ─────────────────────────────────────────────────────────

/** A crawl run/plan on disk, with lifecycle derived from which files exist. */
export interface CrawlEntity {
  dir: string;
  domain: string;
  source: string;
  topics: number;
  files: number;
  createdAt: number;
  status: "plan" | "incomplete" | "complete" | "released" | "curated";
  ready: boolean;
}

export const hasFile = (dir: string, f: string): boolean => {
  try {
    return fs.statSync(path.join(dir, f)).isFile();
  } catch {
    return false;
  }
};

/** Every crawl dir (has a plan.yaml) across the given base dirs, dedup'd. */
export function scanCrawlDirs(bases: string[]): string[] {
  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const base of bases) {
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const e of entries) {
      const dir = path.join(base, e);
      if (seen.has(dir) || !hasFile(dir, "plan.yaml")) continue;
      seen.add(dir);
      dirs.push(dir);
    }
  }
  return dirs;
}

function laneFileMatches(file: string, denTopicId: string): boolean {
  if (!file.endsWith(".md")) return false;
  const base = file.slice(0, -3);
  if (!base.startsWith(denTopicId + "-")) return false;
  return /^[0-9a-f]+$/.test(base.slice(denTopicId.length + 1));
}

/** Which of `denTopicIds` currently have a file in this ops lane dir. */
export function idsInLane(laneDir: string, denTopicIds: string[]): Set<string> {
  const out = new Set<string>();
  let files: string[];
  try {
    files = fs.readdirSync(laneDir);
  } catch {
    return out;
  }
  for (const f of files)
    for (const id of denTopicIds)
      if (laneFileMatches(f, id)) {
        out.add(id);
        break;
      }
  return out;
}

/** den topic ids a run would emit: one per batch + the history entry. */
export function denTopicIdsForPlan(plan: { domain: string; batches?: { topic: string }[] }): string[] {
  const ids = (plan.batches ?? []).map((b) => `crawl-${plan.domain}-${b.topic}`);
  ids.push(`crawl-${plan.domain}-history`);
  return ids;
}

export interface CrawlReleaseState {
  /** emitted.json timestamp (handed to the inbox), if any. */
  releasedAt?: number;
  /** den topic ids Dewey has written a receipt for. */
  curated: Set<string>;
  /** den topic ids still in the inbox. */
  inbox: Set<string>;
}

export function readReleaseState(runDir: string, opsRoot: string | undefined, wolf: string | undefined, denTopicIds: string[]): CrawlReleaseState {
  let releasedAt: number | undefined;
  try {
    releasedAt = JSON.parse(fs.readFileSync(path.join(runDir, "emitted.json"), "utf-8")).at;
  } catch {
    /* never released */
  }
  const curated = opsRoot && wolf ? idsInLane(path.join(opsRoot, "receipts", wolf), denTopicIds) : new Set<string>();
  const inbox = opsRoot && wolf ? idsInLane(path.join(opsRoot, "inbox", wolf), denTopicIds) : new Set<string>();
  return { releasedAt, curated, inbox };
}

export function readCrawlEntity(dir: string, lane?: { opsRoot?: string; wolf?: string }): CrawlEntity | null {
  let plan: ReturnType<typeof readPlan>;
  try {
    plan = readPlan(path.join(dir, "plan.yaml"));
  } catch {
    return null;
  }
  let status: CrawlEntity["status"];
  if (hasFile(dir, "emitted.json")) status = "released";
  else if (hasFile(dir, "history.json")) status = "complete";
  else if (hasFile(dir, "observations.jsonl")) status = "incomplete";
  else status = "plan";
  if ((status === "released" || status === "complete") && lane?.opsRoot && lane?.wolf) {
    const ids = denTopicIdsForPlan(plan);
    const curated = idsInLane(path.join(lane.opsRoot, "receipts", lane.wolf), ids);
    if (curated.size > 0) status = curated.size >= ids.length ? "curated" : "released";
  }
  let topics = 0;
  try {
    topics = (JSON.parse(fs.readFileSync(path.join(dir, "topics.json"), "utf-8")) as unknown[]).length;
  } catch {
    /* none yet */
  }
  const files = plan.batches.reduce((n, b) => n + (b.files?.length ?? 0), 0);
  let createdAt = 0;
  try {
    createdAt = fs.statSync(path.join(dir, "plan.yaml")).mtimeMs;
  } catch {
    /* 0 */
  }
  return { dir, domain: plan.domain, source: plan.source, topics, files, createdAt, status, ready: plan.status === "ready" };
}

/** All crawl entities across bases, newest first. */
export function listCrawls(bases: string[], lane?: { opsRoot?: string; wolf?: string }): CrawlEntity[] {
  return scanCrawlDirs(bases)
    .map((d) => readCrawlEntity(d, lane))
    .filter((e): e is CrawlEntity => !!e)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Newest plan, preferring `status: ready` ones. */
export function findLatestPlan(bases: string[]): string | null {
  const all = listCrawls(bases);
  if (all.length === 0) return null;
  all.sort((a, b) => Number(b.ready) - Number(a.ready) || b.createdAt - a.createdAt);
  return path.join(all[0].dir, "plan.yaml");
}

export interface IncompleteRun {
  runDir: string;
  /** Batch topics not yet in topics.json (empty = extraction done, journey not). */
  missing: string[];
  done: number;
  total: number;
  domain: string;
  /** history.json exists but batches are still missing (completed with errors). */
  journeyWritten: boolean;
  mtime: number;
}

/** Resumable runs of this plan (same source + domain), newest first: extraction began and it is not fully done. */
export function findIncompleteRuns(resolved: { source: string; domain: string }, bases: string[]): IncompleteRun[] {
  const found: IncompleteRun[] = [];
  for (const dir of scanCrawlDirs(bases)) {
    if (!hasFile(dir, "observations.jsonl")) continue; // never ran (plan dir)
    let plan: ReturnType<typeof readPlan>;
    try {
      plan = readPlan(path.join(dir, "plan.yaml"));
    } catch {
      continue;
    }
    if (plan.source !== resolved.source || plan.domain !== resolved.domain) continue;
    let doneTopics = new Set<string>();
    try {
      doneTopics = new Set((JSON.parse(fs.readFileSync(path.join(dir, "topics.json"), "utf-8")) as [string, unknown][]).map(([k]) => k));
    } catch {
      /* nothing completed yet */
    }
    const topics = plan.batches.map((b) => b.topic);
    const missing = topics.filter((t) => !doneTopics.has(t));
    const journeyWritten = hasFile(dir, "history.json");
    if (journeyWritten && missing.length === 0) continue;
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(dir, "plan.yaml")).mtimeMs;
    } catch {
      /* 0 */
    }
    found.push({ runDir: dir, missing, done: doneTopics.size, total: topics.length, domain: plan.domain, journeyWritten, mtime });
  }
  return found.sort((a, b) => b.mtime - a.mtime);
}

/** Compact "Nm/Nh/Nd ago" from an epoch-ms timestamp. */
export function agoLabel(ms: number, now = Date.now()): string {
  const mins = Math.floor((now - ms) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** One-line description of an outstanding run (the resume picker). */
export function incompleteRunLabel(r: IncompleteRun, now = Date.now()): string {
  const bits = [`${r.done}/${r.total} batches`];
  if (r.missing.length > 0) bits.push(`${r.missing.length} remaining`);
  bits.push(r.journeyWritten ? "journey written" : "journey pending");
  return `${path.basename(r.runDir)} — ${bits.join(" · ")} · ${agoLabel(r.mtime, now)}`;
}

/** One-line label for a crawl in the release picker. */
export function crawlEntityLabel(e: CrawlEntity, now = Date.now()): string {
  return `${path.basename(e.dir)} · ${e.domain} · ${e.topics || e.files} ${e.topics ? "topics" : "files"} · ${e.status} · ${agoLabel(e.createdAt, now)}`;
}

// ── a run in flight ────────────────────────────────────────────────────────

export interface RunRow {
  topic: string;
  index: number;
  stage: CrawlBatchStage;
  files: number;
  scanned?: number;
  observations?: number;
  title?: string;
  error?: string;
}

/** What the monitor shows pi users, as data: per-batch rows, the journey pass, token usage. */
export interface RunProgress {
  total: number;
  rows: Map<string, RunRow>;
  journey: "pending" | "running" | "done";
  gateFailures?: string[];
  usage?: CrawlUsageStats;
  startedAt: number;
}

export const newRunProgress = (): RunProgress => ({ total: 0, rows: new Map(), journey: "pending", startedAt: Date.now() });

export function applyProgress(s: RunProgress, p: CrawlProgress): void {
  switch (p.phase) {
    case "gate":
      if (!p.ok) s.gateFailures = p.failures ?? [];
      return;
    case "batch": {
      const b = p.batch;
      s.total = b.total;
      s.rows.set(b.topic, { topic: b.topic, index: b.index, stage: b.stage, files: b.files, scanned: b.scanned, observations: b.observations, title: b.title, error: b.error });
      return;
    }
    case "stats":
      s.usage = p.usage;
      return;
    case "journey":
      s.journey = p.status === "done" ? "done" : "running";
      return;
    case "complete":
      return;
  }
}

const fmtTokens = (n: number): string => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`);

/** Plain-text progress/summary of a run, for the status tool and the completion report. */
export function renderProgress(s: RunProgress, now = Date.now()): string {
  const rows = [...s.rows.values()].sort((a, b) => a.index - b.index);
  const count = (st: CrawlBatchStage) => rows.filter((r) => r.stage === st).length;
  const finished = count("done") + count("skipped") + count("error");
  const lines = [`batches: ${finished}/${s.total || rows.length} finished · ${count("done")} ok · ${count("skipped")} empty · ${count("error")} failed · journey ${s.journey}`];
  for (const r of rows.filter((x) => x.stage !== "done" && x.stage !== "skipped")) {
    lines.push(`  ${r.stage === "error" ? "✗" : "…"} ${r.topic} [${r.stage}]${r.scanned !== undefined ? ` ${r.scanned}/${r.files} files` : ""}${r.error ? ` — ${r.error}` : ""}`);
  }
  const u = s.usage;
  lines.push(
    `${rows.reduce((n, r) => n + r.files, 0)} files · ${rows.reduce((n, r) => n + (r.observations ?? 0), 0)} observations · ${Math.floor((now - s.startedAt) / 1000)}s` +
      (u ? ` · ↑${fmtTokens(u.input)}/↓${fmtTokens(u.output)} tok` : ""),
  );
  return lines.join("\n");
}
