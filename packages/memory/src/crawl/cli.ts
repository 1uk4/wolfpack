/**
 * cli — the deterministic front-end driver (dev + automation). `planCrawl`
 * discovers, resolves dates, builds + writes a plan, and dumps the full
 * observability tree to /tmp (spec §4). No LLM, no KB writes — this is the
 * stage we can watch before any model runs.
 */
import { statSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  discoverSources,
  type DiscoverOptions,
} from "./discover.js";
import { resolveDates, isGitRepo } from "./dates.js";
import { buildPlan } from "./group.js";
import { writePlan, renderPlanSummary } from "./plan.js";
import { createSink, type CrawlSink } from "./sink.js";
import type { CrawlPlan, Strategy, Currency, DatedFile } from "./schemas.js";

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

// ── run (phase 2) ─────────────────────────────────────────────────────────────
// Execute a REVIEWED plan. Enforces the run gate first — a crawl never starts
// from a draft plan. Writes the full /tmp pipeline (extract → consolidate →
// journey). Mirrors what /wolf:crawl-run will do (spec §11).

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
  const { readPlan, gatePlan } = await import("./plan.js");
  const { discoverSources } = await import("./discover.js");
  const { resolveDates, isGitRepo } = await import("./dates.js");

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required to run a crawl.");

  const useGit = isGitRepo(plan.source);
  const dated = resolveDates(files, { useGit });
  const byPath = new Map(dated.map((f) => [f.relPath, f]));

  const { createEngine } = await import("@wolfpack/engine");
  const { extractBatch } = await import("./extract.js");
  const { consolidateBatch, computeTemporal, renderTopicDoc } = await import(
    "./consolidate.js"
  );
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
  sink.log(
    `run: ${total} batch(es), up to ${concurrency} at once ` +
      `(extract ${fastModel} → consolidate ${smartModel})`
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
  type Topic = import("./consolidate.js").CrawlTopic;
  const topicByName = new Map<string, Topic>();
  // Rerun: preload the topics that already succeeded so the journey (and the
  // rewritten topics.json) still reflects the full set, not just the fixes.
  if (rerun) {
    try {
      const prior = JSON.parse(
        readFileSync(join(sink.dir, "topics.json"), "utf-8")
      ) as [string, Topic][];
      for (const [k, v] of prior) topicByName.set(k, v);
      sink.log(`rerun: preloaded ${topicByName.size} existing topic(s)`);
    } catch {
      /* no prior topics.json — journey will use just the reran batches */
    }
  }

  // Persist a plan-ordered topics.json snapshot after every batch so an
  // interrupted run (crash / relaunch) can be resumed: membership here is the
  // source of truth for which batches are done.
  const writeTopicsSnapshot = () => {
    const ordered: [string, Topic][] = [];
    for (const bb of limited.batches) {
      const t = topicByName.get(bb.topic);
      if (t) ordered.push([bb.topic, t]);
    }
    sink.file("topics.json", JSON.stringify(ordered, null, 2));
  };

  const signal = opts.signal;
  await mapWithConcurrencyLimit(batchesToRun, concurrency, async (b, index) => {
    if (signal?.aborted) return; // don't start new batches after a cancel
    const bFiles = b.files
      .map((rel) => byPath.get(rel))
      .filter((f): f is DatedFile => !!f);
    const base = { topic: b.topic, index, total, files: bFiles.length };
    onProgress?.({
      phase: "batch",
      batch: { ...base, stage: "extract", scanned: 0, observations: 0 },
    });
    try {
      const obs = await extractBatch(engine, limited, b.topic, bFiles, sink, {
        signal,
        onFile: (scanned, _total, observations) => {
          onProgress?.({
            phase: "batch",
            batch: { ...base, stage: "extract", scanned, observations },
          });
          emitStats();
        },
      });
      // Interrupted mid-extract: its observations are partial — skip
      // consolidation so a resume redoes the whole batch cleanly.
      if (signal?.aborted) {
        onProgress?.({
          phase: "batch",
          batch: { ...base, stage: "skipped", observations: obs.length },
        });
        return;
      }
      onProgress?.({
        phase: "batch",
        batch: {
          ...base,
          stage: "consolidate",
          scanned: bFiles.length,
          observations: obs.length,
        },
      });
      emitStats();
      if (obs.length === 0) {
        sink.log(`batch ${b.topic}: 0 observations — skipped`);
        onProgress?.({
          phase: "batch",
          batch: { ...base, stage: "skipped", observations: 0 },
        });
        return;
      }
      const currency = b.currency ?? limited.currency;
      const topic = await sink.heartbeat(
        `consolidating ${b.topic} (${obs.length} obs)`,
        () =>
          consolidateBatch(engine, {
            topic: b.topic,
            currency,
            observations: obs,
          })
      );
      const temporal = computeTemporal(bFiles);
      const batchId = `crawl-${limited.domain}-${b.topic}`;
      sink.file(
        join("topics", `${b.topic}.md`),
        renderTopicDoc(batchId, topic, temporal, currency, limited.source)
      );
      topicByName.set(b.topic, topic);
      writeTopicsSnapshot();
      sink.log(`batch ${b.topic}: ${obs.length} obs → "${topic.title}"`);
      onProgress?.({
        phase: "batch",
        batch: {
          ...base,
          stage: "done",
          scanned: bFiles.length,
          observations: obs.length,
          title: topic.title,
        },
      });
      emitStats();
    } catch (err) {
      sink.log(`batch ${b.topic}: ERROR ${String(err)}`);
      onProgress?.({
        phase: "batch",
        batch: { ...base, stage: "error", error: String(err) },
      });
      emitStats();
    }
  });
  emitStats();

  // Reassemble topics in plan order so downstream artifacts stay deterministic
  // regardless of batch completion order.
  const topics = new Map<string, Topic>();
  for (const b of limited.batches) {
    const t = topicByName.get(b.topic);
    if (t) topics.set(b.topic, t);
  }
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

// Shared journey tail: dump topics.json, reconstruct the arc, write history.
async function journeyTail(
  engine: import("@wolfpack/engine").Engine,
  plan: CrawlPlan,
  topics: Map<string, import("./consolidate.js").CrawlTopic>,
  sink: CrawlSink,
  smartModel: string,
  onProgress?: (p: CrawlProgress) => void
): Promise<void> {
  const { buildJourney, renderHistoryDoc } = await import("./journey.js");
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

// Shared tail used by `resume`: consolidate ALL batches then journey.
async function consolidateAndJourney(
  engine: import("@wolfpack/engine").Engine,
  plan: CrawlPlan,
  obs: Map<string, import("./extract.js").CrawlObservation[]>,
  byPath: Map<string, DatedFile>,
  sink: CrawlSink,
  smartModel: string
): Promise<void> {
  const { consolidateCrawl } = await import("./consolidate.js");
  // Digest priming: brief the crawl with what the pack already knows (the
  // "PACK ALREADY KNOWS" block). Absent for a fresh domain, so just skip it.
  let publishedDigest: any;
  const kbBase = process.env.KB_BASE;
  if (kbBase) {
    const dp = join(kbBase, "domains", plan.domain, "_digest.json");
    if (existsSync(dp)) {
      try { publishedDigest = JSON.parse(readFileSync(dp, "utf-8")); } catch { /* ignore */ }
    }
  }
  sink.log(
    `consolidate: ${plan.batches.length} batch(es) on ${smartModel}` +
      (publishedDigest ? ` (digest-primed)` : "")
  );
  const topics = await consolidateCrawl(engine, plan, obs, byPath, sink, publishedDigest);
  sink.log(`consolidate done: ${topics.size} topic(s) → topics/`);
  await journeyTail(engine, plan, topics, sink, smartModel);
}

// \u2500\u2500 resume: re-run cheap LLM stages against a prior run's artifacts \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
//   from "observations" (default): re-consolidate + journey from observations.jsonl
//   from "topics":                 re-journey only from topics.json
export async function resumeCrawl(
  runDir: string,
  opts: { from?: "observations" | "topics"; sinkBase?: string } = {}
): Promise<void> {
  const from = opts.from ?? "observations";
  const { readPlan } = await import("./plan.js");
  const plan = readPlan(join(runDir, "plan.yaml"));
  const sink = createSink(`resume-${Date.now()}`, opts.sinkBase);
  sink.log(`resume start: from=${from} src=${runDir} domain=${plan.domain}`);
  writePlan(join(sink.dir, "plan.yaml"), plan);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY required.");
    process.exit(1);
  }
  const { createEngine } = await import("@wolfpack/engine");
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

  if (from === "topics") {
    const { buildJourney, renderHistoryDoc } = await import("./journey.js");
    const entries = JSON.parse(
      readFileSync(join(runDir, "topics.json"), "utf-8")
    ) as [string, import("./consolidate.js").CrawlTopic][];
    const topics = new Map(entries);
    sink.log(`loaded ${topics.size} topic(s) from topics.json`);
    const jr = await buildJourney(engine, plan, topics, sink);
    sink.file("topics/_history.md", renderHistoryDoc(plan.domain, jr));
    sink.log(`journey done: ${jr.datedCount} dated, ${jr.undatedCount} undated`);
    console.log(`\nOutput: ${sink.dir}`);
    return;
  }

  // from observations: regroup saved observations, re-consolidate + journey.
  const { discoverSources } = await import("./discover.js");
  const rawObs = readFileSync(join(runDir, "observations.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as import("./extract.js").CrawlObservation);
  const obs = new Map<string, import("./extract.js").CrawlObservation[]>();
  for (const o of rawObs) {
    (obs.get(o.batch) ?? obs.set(o.batch, []).get(o.batch)!).push(o);
  }
  sink.log(`loaded ${rawObs.length} observation(s) across ${obs.size} batch(es)`);

  const files = discoverSources(plan.source, { include: plan.include, exclude: plan.exclude });
  const dated = resolveDates(files, { useGit: isGitRepo(plan.source) });
  const byPath = new Map(dated.map((f) => [f.relPath, f]));
  await consolidateAndJourney(engine, plan, obs, byPath, sink, smartModel);
  console.log(`\nOutput: ${sink.dir}`);
}

// ── direct invocation ─────────────────────────────────────────────────────────
//   crawl plan <source> <domain> [strategy] [--depth N] [--ready] [--out FILE]
//   crawl run  <plan.yaml> [--limit N]
const USAGE = [
  "usage:",
  "  crawl plan   <source> <domain> [by-folder|by-pattern] [--depth N] [--ready] [--out FILE]",
  "  crawl run    <plan.yaml> [--limit N] [--concurrency N]",
  "  crawl resume <run-dir> [--from observations|topics]   # reuse saved artifacts",
  "  crawl emit   <run-dir> [--dry-run]                    # release staged topics to inbox",
].join("\n");

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  process.argv[1].endsWith("crawl/cli.js");

if (isMain) {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;
  const flag = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };

  if (cmd === "plan") {
    const positional = rest.filter((a) => !a.startsWith("--"));
    const [source, domain, strategy = "by-folder"] = positional;
    if (!source || !domain) {
      console.error(USAGE);
      process.exit(1);
    }
    const depth = flag("--depth");
    const { plan, sink } = planCrawl({
      source,
      domain,
      strategy: strategy as Strategy,
      folderDepth: depth ? Number(depth) : undefined,
    });
    const ready = rest.includes("--ready");
    const finalPlan = ready ? { ...plan, status: "ready" as const } : plan;
    const out = flag("--out");
    if (out || ready) {
      const target = out ?? `${sink.dir}/plan.yaml`;
      writePlan(target, finalPlan);
      console.log(`Plan written: ${target} (status: ${finalPlan.status})`);
    }
    console.log(
      `\nReview the plan, set 'status: ready', then:\n  crawl run ${out ?? sink.dir + "/plan.yaml"}\n\nOutput: ${sink.dir}`
    );
  } else if (cmd === "run") {
    const planPath = rest.find((a) => !a.startsWith("--"));
    if (!planPath) {
      console.error(USAGE);
      process.exit(1);
    }
    const lim = flag("--limit");
    const conc = flag("--concurrency");
    runCrawl(planPath, {
      limit: lim ? Number(lim) : undefined,
      concurrency: conc ? Number(conc) : undefined,
    })
      .then((r) => {
        if (!r.ok) {
          console.error(
            `\nRun refused. Fix the plan and set status: ready.\n  ` +
              (r.failures ?? []).join("\n  ") +
              `\n\nLog: ${r.dir}`
          );
          process.exit(2);
        }
        console.log(`\nOutput: ${r.dir}`);
      })
      .catch((e) => {
        console.error(e);
        process.exit(1);
      });
  } else if (cmd === "resume") {
    const runDir = rest.find((a) => !a.startsWith("--"));
    if (!runDir) {
      console.error(USAGE);
      process.exit(1);
    }
    const fromRaw = flag("--from");
    const fromOpt = fromRaw === "topics" ? "topics" : "observations";
    resumeCrawl(runDir, { from: fromOpt }).catch((e) => {
      console.error(e);
      process.exit(1);
    });
  } else if (cmd === "emit") {
    const runDir = rest.find((a) => !a.startsWith("--"));
    if (!runDir) {
      console.error(USAGE);
      process.exit(1);
    }
    import("./emit.js").then(({ emitCrawl }) =>
      emitCrawl(runDir, { dryRun: rest.includes("--dry-run") })
    );
  } else {
    console.error(USAGE);
    process.exit(1);
  }
}
