/**
 * run — execute a REVIEWED crawl plan (phase 2). Enforces the run gate first
 * (a crawl never starts from a draft plan), then extract → consolidate per
 * batch in parallel, then one global journey pass. Writes the full pipeline to
 * the sink. Also holds the helpers `resume` shares: engine setup, dated-file
 * resolution, digest loading, and the journey tail.
 */
import { statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createEngine, type Engine } from "@wolfpack/engine";
import type { ContextDigest } from "@wolfpack/kb/shared";
import { discoverSources } from "./discover.js";
import { resolveDates, isGitRepo } from "./dates.js";
import { readPlan, writePlan, gatePlan } from "./plan.js";
import { createSink, type CrawlSink } from "./sink.js";
import { extractBatch } from "./extract.js";
import { consolidateTopic, createRunningDigest, type CrawlTopic } from "./consolidate.js";
import { buildJourney, renderHistoryDoc } from "./journey.js";
import type { CrawlPlan, DatedFile, SourceFile } from "./schemas.js";

// ── shared helpers (run + resume) ─────────────────────────────────────────────

/** Engine for a crawl: fast model extracts, smart model consolidates + journeys. */
export function createCrawlEngine(): { engine: Engine; fastModel: string; smartModel: string } {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required to run a crawl.");
  const fastModel = process.env.WOLFPACK_FAST_MODEL ?? "claude-haiku-4-5-20251001";
  const smartModel = process.env.WOLFPACK_MODEL ?? "claude-sonnet-4-6";
  const engine = createEngine({
    provider: "anthropic",
    apiKey,
    defaultModel: smartModel,
    steps: {
      classify: { model: fastModel, maxTokens: 8192 },
      consolidate: { model: smartModel, maxTokens: 16000 },
    },
  });
  return { engine, fastModel, smartModel };
}

/** Resolve dates for a plan's discovered files, keyed by relPath. */
export function datedByPath(plan: CrawlPlan, files: SourceFile[]): Map<string, DatedFile> {
  const dated = resolveDates(files, { useGit: isGitRepo(plan.source) });
  return new Map(dated.map((f) => [f.relPath, f]));
}

/** The domain's published KB digest ("PACK ALREADY KNOWS"), if the KB has one. */
export function loadPublishedDigest(domain: string): ContextDigest | undefined {
  const kbBase = process.env.KB_BASE;
  if (!kbBase) return undefined;
  const path = join(kbBase, "domains", domain, "_digest.json");
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ContextDigest;
  } catch {
    return undefined;
  }
}

/** Plan-ordered topics, so artifacts are deterministic regardless of finish order. */
export function topicsInPlanOrder(plan: CrawlPlan, byName: Map<string, CrawlTopic>): Map<string, CrawlTopic> {
  const ordered = new Map<string, CrawlTopic>();
  for (const b of plan.batches) {
    const t = byName.get(b.topic);
    if (t) ordered.set(b.topic, t);
  }
  return ordered;
}

// ── run ───────────────────────────────────────────────────────────────────────

/** Default max batches processed at once. */
export const DEFAULT_CRAWL_CONCURRENCY = 5;

/** Lifecycle of one batch as it moves through the per-batch pipeline. */
export type CrawlBatchStage =
  | "extract"
  | "consolidate"
  | "done"
  | "skipped"
  | "error";

export interface CrawlBatchProgress {
  /** Batch topic (slug). */
  topic: string;
  /** 0-based position in the (possibly limited) batch list. */
  index: number;
  /** Total batches in this run. */
  total: number;
  /** Current stage. */
  stage: CrawlBatchStage;
  /** Files claimed by the batch. */
  files: number;
  /** Files scanned so far during extract (for a live sub-progress bar). */
  scanned?: number;
  /** Observations extracted so far / total (known from extract on). */
  observations?: number;
  /** Consolidated topic title (known at done). */
  title?: string;
  /** Error text (stage === "error"). */
  error?: string;
}

/** Cumulative engine usage snapshot (tokens + calls across all batches). */
export interface CrawlUsageStats {
  input: number;
  output: number;
  calls: number;
}

/** Progress events emitted by runCrawl. Headless callers omit the callback. */
export type CrawlProgress =
  | { phase: "gate"; ok: boolean; failures?: string[] }
  | { phase: "batch"; batch: CrawlBatchProgress }
  | { phase: "stats"; usage: CrawlUsageStats }
  | {
      phase: "journey";
      status: "start" | "done";
      dated?: number;
      undated?: number;
    }
  | { phase: "complete"; dir: string };

export interface RunCrawlOptions {
  /** Dev cost control: only the first N batches. */
  limit?: number;
  sinkBase?: string;
  /** Declared KB domains for the gate (null/undefined = unconstrained). */
  declared?: Set<string> | null;
  /** Max batches processed at once (default DEFAULT_CRAWL_CONCURRENCY). */
  concurrency?: number;
  /** Live progress callback for monitors/TUIs. Omitted on the headless path. */
  onProgress?: (p: CrawlProgress) => void;
  /** Cooperative cancellation: stop launching new batch work when aborted. */
  signal?: AbortSignal;
  /**
   * Rerun mode: only process batches whose topic is in this list. Existing
   * topics are loaded from the run dir's topics.json first, so the global
   * journey still sees the full set.
   */
  only?: string[];
  /**
   * Rerun mode: reuse this exact run dir (from a prior runCrawl result) instead
   * of creating a fresh one, so reran batches merge into the same output and
   * `emit` picks up everything. plan.yaml is left untouched in this mode.
   */
  runDir?: string;
}

/**
 * Run `fn` over `items` with at most `concurrency` in flight. Order-preserving
 * for side effects is not guaranteed; callers that need deterministic output
 * reassemble results by a stable key afterwards.
 */
export async function mapWithConcurrencyLimit<TIn>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      await fn(items[current], current);
    }
  });
  await Promise.all(workers);
}

export interface RunCrawlResult {
  ok: boolean;
  failures?: string[];
  /** True when the run was aborted via opts.signal (partial; resumable). */
  cancelled?: boolean;
  dir: string;
}

/** Execute a reviewed plan. Returns a result (never process.exits) so it is safe
 *  to call from the pi extension. */
export async function runCrawl(
  planPath: string,
  opts: RunCrawlOptions = {}
): Promise<RunCrawlResult> {
  const plan = readPlan(planPath);
  // Reuse-dir mode (rerun failed batches / resume an interrupted run) merges
  // into the prior run dir; otherwise start a fresh, self-describing run dir.
  const rerun = !!opts.runDir;
  const sink = opts.runDir
    ? createSink("", opts.runDir)
    : createSink(`run-${Date.now()}`, opts.sinkBase);
  const onlyCount = opts.only?.length ?? 0;
  sink.log(
    `run start: plan=${planPath} domain=${plan.domain}` +
      (rerun ? ` (reuse ${opts.runDir}; ${onlyCount || "journey-only"})` : "")
  );

  let sourceExists = false;
  try {
    sourceExists = statSync(plan.source).isDirectory();
  } catch {
    /* stays false */
  }
  const files = discoverSources(plan.source, {
    include: plan.include,
    exclude: plan.exclude,
  });

  // Declared-domain check is enforced by the real run (KB configured); in dev
  // without KB_BASE it is unconstrained (null).
  const declared = opts.declared ?? null;
  const fails = gatePlan(plan, { files, declared, sourceExists });
  if (fails.length > 0) {
    sink.log("GATE FAILED — refusing to crawl:");
    for (const f of fails) sink.log(`  ✗ ${f}`);
    opts.onProgress?.({ phase: "gate", ok: false, failures: fails });
    return { ok: false, failures: fails, dir: sink.dir };
  }
  opts.onProgress?.({ phase: "gate", ok: true });
  sink.log(
    `gate passed (declared-domain check ${declared ? "on" : "skipped (unconstrained)"})`
  );

  const { engine, fastModel, smartModel } = createCrawlEngine();
  const byPath = datedByPath(plan, files);

  const limited =
    opts.limit && opts.limit > 0
      ? { ...plan, batches: plan.batches.slice(0, opts.limit) }
      : plan;
  // Reuse-dir mode processes only the named batches (empty = journey-only,
  // for resuming a run that finished extraction but not the journey). A normal
  // run processes every batch.
  const onlySet =
    opts.only && opts.only.length ? new Set(opts.only) : null;
  const batchesToRun = rerun
    ? onlySet
      ? limited.batches.filter((b) => onlySet.has(b.topic))
      : []
    : limited.batches;
  // Self-describing run dir so `resume` can reuse it. Rerun keeps the original
  // full plan — don't clobber it with the filtered subset.
  if (!rerun) writePlan(join(sink.dir, "plan.yaml"), limited);

  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CRAWL_CONCURRENCY);
  const onProgress = opts.onProgress;
  const total = batchesToRun.length;
  const published = loadPublishedDigest(limited.domain);
  const digest = createRunningDigest(limited.domain, published);
  sink.log(
    `run: ${total} batch(es), up to ${concurrency} at once ` +
      `(extract ${fastModel} → consolidate ${smartModel})` +
      (published ? " (digest-primed)" : "")
  );

  // Shared checkpoint: push cumulative engine usage to the monitor header.
  const emitStats = () => {
    if (!onProgress) return;
    const u = engine.usage.summarize();
    onProgress({
      phase: "stats",
      usage: {
        input: u.totalInputTokens,
        output: u.totalOutputTokens,
        calls: u.callCount,
      },
    });
  };

  // Per-batch unit: extract → consolidate, bounded to `concurrency` in flight.
  // Journey is a GLOBAL pass that runs only after every batch resolves.
  const topicByName = new Map<string, CrawlTopic>();
  // Rerun: preload the topics that already succeeded so the journey (and the
  // rewritten topics.json) still reflects the full set, not just the fixes —
  // and so reran batches are primed with them via the running digest.
  if (rerun) {
    try {
      const prior = JSON.parse(
        readFileSync(join(sink.dir, "topics.json"), "utf-8")
      ) as [string, CrawlTopic][];
      for (const [k, v] of prior) {
        topicByName.set(k, v);
        const batch = limited.batches.find((b) => b.topic === k);
        digest.add(`crawl-${limited.domain}-${k}`, v, batch?.currency ?? limited.currency);
      }
      sink.log(`rerun: preloaded ${topicByName.size} existing topic(s)`);
    } catch {
      /* no prior topics.json — journey will use just the reran batches */
    }
  }

  // Persist a plan-ordered topics.json snapshot after every batch so an
  // interrupted run (crash / relaunch) can be resumed: membership here is the
  // source of truth for which batches are done.
  const writeTopicsSnapshot = () => {
    const ordered = topicsInPlanOrder(limited, topicByName);
    sink.file("topics.json", JSON.stringify([...ordered.entries()], null, 2));
  };

  const signal = opts.signal;
  await mapWithConcurrencyLimit(batchesToRun, concurrency, async (b, index) => {
    if (signal?.aborted) return; // don't start new batches after a cancel
    const bFiles = b.files
      .map((rel) => byPath.get(rel))
      .filter((f): f is DatedFile => !!f);
    const report = (stage: CrawlBatchStage, extra: Partial<CrawlBatchProgress> = {}) =>
      onProgress?.({
        phase: "batch",
        batch: { topic: b.topic, index, total, files: bFiles.length, stage, ...extra },
      });
    report("extract", { scanned: 0, observations: 0 });
    try {
      const obs = await extractBatch(engine, limited, b.topic, bFiles, sink, {
        signal,
        onFile: (scanned, _total, observations) => {
          report("extract", { scanned, observations });
          emitStats();
        },
      });
      // Interrupted mid-extract: its observations are partial — skip
      // consolidation so a resume redoes the whole batch cleanly.
      if (signal?.aborted) {
        report("skipped", { observations: obs.length });
        return;
      }
      report("consolidate", { scanned: bFiles.length, observations: obs.length });
      emitStats();
      if (obs.length === 0) {
        sink.log(`batch ${b.topic}: 0 observations — skipped`);
        report("skipped", { observations: 0 });
        return;
      }
      const topic = await consolidateTopic(engine, {
        plan: limited,
        topic: b.topic,
        currency: b.currency ?? limited.currency,
        observations: obs,
        files: bFiles,
        sink,
        digest,
      });
      topicByName.set(b.topic, topic);
      writeTopicsSnapshot();
      report("done", { scanned: bFiles.length, observations: obs.length, title: topic.title });
      emitStats();
    } catch (err) {
      sink.log(`batch ${b.topic}: ERROR ${String(err)}`);
      report("error", { error: String(err) });
      emitStats();
    }
  });
  emitStats();

  const topics = topicsInPlanOrder(limited, topicByName);
  sink.log(`extract+consolidate done: ${topics.size} topic(s) → topics/`);

  // Cancelled: skip the global journey so no history.json is written — the run
  // stays "incomplete", which is exactly what the resume flow looks for.
  if (signal?.aborted) {
    sink.log(`run cancelled: ${topics.size} topic(s) kept, journey skipped`);
    return { ok: false, cancelled: true, dir: sink.dir };
  }

  await journeyTail(engine, limited, topics, sink, smartModel, onProgress);
  onProgress?.({ phase: "complete", dir: sink.dir });
  return { ok: true, dir: sink.dir };
}

/** Shared journey tail: dump topics.json, reconstruct the arc, write history. */
export async function journeyTail(
  engine: Engine,
  plan: CrawlPlan,
  topics: Map<string, CrawlTopic>,
  sink: CrawlSink,
  smartModel: string,
  onProgress?: (p: CrawlProgress) => void
): Promise<void> {
  // Structured dump so `resume --from topics` can re-journey without re-consolidating.
  sink.file("topics.json", JSON.stringify([...topics.entries()], null, 2));

  onProgress?.({ phase: "journey", status: "start" });
  sink.log(`journey: reconstructing arc on ${smartModel}`);
  const jr = await buildJourney(engine, plan, topics, sink);
  sink.file("topics/_history.md", renderHistoryDoc(plan.domain, jr));
  // Structured dump so `emit` can release the history entry deterministically.
  sink.file("history.json", JSON.stringify(jr, null, 2));
  sink.log(
    `journey done: ${jr.datedCount} dated, ${jr.undatedCount} undated → journey.md`
  );
  onProgress?.({
    phase: "journey",
    status: "done",
    dated: jr.datedCount,
    undated: jr.undatedCount,
  });
}
