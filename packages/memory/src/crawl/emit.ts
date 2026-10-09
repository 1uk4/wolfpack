/**
 * emit — release a reviewed run's staged topics (+ history) to the librarian
 * inbox as scribe contributions (spec §10). This is the irreversible, shared-
 * blast-radius step, kept SEPARATE from `run` on purpose: you review the actual
 * generated knowledge first, then release it. Deterministic (no LLM) and
 * idempotent (emitDelta hash-dedups).
 *
 *   --dry-run : render the exact contribution files to <sink>/inbox/ instead of
 *               the real KB_OPS inbox, so you can see precisely what Dewey gets.
 *
 * Note: the inbox is NOT the KB. Dewey's sweep still routes/guards/produces
 * before anything is committed. This step just hands contributions to that lane.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { emitDelta } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { readPlan } from "./plan.js";
import { discoverSources } from "./discover.js";
import { resolveDates, isGitRepo } from "./dates.js";
import {
  computeTemporal,
  renderDecisions,
  type CrawlTopic,
} from "./consolidate.js";
import type { JourneyResult } from "./journey.js";
import { createSink } from "./sink.js";
import type { DatedFile } from "./schemas.js";

export interface EmitCrawlOptions {
  /** Render to <sink>/inbox/ instead of the real KB_OPS inbox. */
  dryRun?: boolean;
  /**
   * The wolf these contributions are attributed to — defaults to the RUNNING
   * wolf (WOLF_NAME) so they ride that wolf's existing synced inbox lane to
   * Dewey. "scribe" is a ROLE (origin: crawl), not a separate identity, so any
   * wolf can crawl knowledge in its location and have it reach the librarian.
   */
  wolf?: string;
  sinkBase?: string;
  /**
   * Suppress the stderr dev-microscope echo and the stdout summary line.
   * The run.log file is still written. TUI callers set this so they can render
   * their own clean closeout instead of leaking raw pipeline output.
   */
  quiet?: boolean;
}

/** One contribution that emit would (or did) hand to the inbox. */
export interface EmitContribution {
  kind: "topic" | "history";
  /** Batch topic slug (kind=topic) or "history". */
  topic: string;
  denTopicId: string;
  title: string;
  summary: string;
  /** Characters in the rendered body (size hint for review). */
  bodyChars: number;
  sourceCreated?: string;
  sourceUpdated?: string;
  currency: string;
  /** "emit" = new/changed (would be written); "skip" = unchanged (dedup). */
  status: "emit" | "skip";
}

export interface EmitCrawlResult {
  emitted: number;
  skipped: number;
  dest: string;
  dir: string;
  /** Per-contribution detail, in plan order (history last). */
  contributions: EmitContribution[];
}

export function emitCrawl(
  runDir: string,
  opts: EmitCrawlOptions = {}
): EmitCrawlResult {
  const wolf = opts.wolf ?? process.env.WOLF_NAME ?? "scribe";
  const plan = readPlan(join(runDir, "plan.yaml"));
  const sink = createSink(`emit-${Date.now()}`, opts.sinkBase, opts.quiet);
  sink.log(`emit start: src=${runDir} domain=${plan.domain} dryRun=${!!opts.dryRun}`);

  // Resolve the inbox target. Dry-run writes into the sink so you can inspect
  // the exact contribution files; a real emit requires KB_OPS.
  const opsRoot = opts.dryRun ? sink.dir : process.env.KB_OPS;
  if (!opsRoot) {
    throw new Error(
      "KB_OPS is required to emit to the real inbox (or use --dry-run)."
    );
  }
  const roots: KbRoots = {
    kbBase: process.env.KB_BASE ?? "",
    opsRoot,
    denLocal: join(process.env.WOLF_DEN ?? join(homedir(), "wolves", "den"), "kb"),
  };

  // Load the staged topics + history produced by run/resume.
  const topicEntries = JSON.parse(
    readFileSync(join(runDir, "topics.json"), "utf-8")
  ) as [string, CrawlTopic][];
  const topics = new Map(topicEntries);

  // Temporal is recomputed deterministically from the source files.
  const files = discoverSources(plan.source, {
    include: plan.include,
    exclude: plan.exclude,
  });
  const dated = resolveDates(files, { useGit: isGitRepo(plan.source) });
  const byPath = new Map(dated.map((f) => [f.relPath, f]));

  let emitted = 0;
  let skipped = 0;
  const contributions: EmitContribution[] = [];

  for (const b of plan.batches) {
    const topic = topics.get(b.topic);
    if (!topic) continue;
    const batchFiles = b.files
      .map((rel) => byPath.get(rel))
      .filter((f): f is DatedFile => !!f);
    const temporal = computeTemporal(batchFiles);
    const currency = b.currency ?? plan.currency;
    const body = `${topic.body}${renderDecisions(topic.events ?? [])}`;

    const result = emitDelta({
      roots,
      wolf,
      denTopicId: `crawl-${plan.domain}-${b.topic}`,
      change: "create",
      domainHint: plan.domain,
      summary: topic.summary,
      body,
      sourceCreated: temporal.sourceCreated,
      sourceUpdated: temporal.sourceUpdated,
      dateBasis: temporal.dateBasis,
      dateConfidence: temporal.dateConfidence,
      currency,
      sourcePath: plan.source,
      origin: "crawl",
    });
    contributions.push({
      kind: "topic",
      topic: b.topic,
      denTopicId: `crawl-${plan.domain}-${b.topic}`,
      title: topic.title,
      summary: topic.summary,
      bodyChars: body.length,
      sourceCreated: temporal.sourceCreated,
      sourceUpdated: temporal.sourceUpdated,
      currency,
      status: result ? "emit" : "skip",
    });
    if (result) {
      emitted++;
      sink.log(`emit: ${b.topic} → ${result.denTopicId}`);
    } else {
      skipped++;
      sink.log(`emit: ${b.topic} unchanged — skipped`);
    }
  }

  // The per-domain history entry (append-not-supersede; marked archived).
  try {
    const jr = JSON.parse(
      readFileSync(join(runDir, "history.json"), "utf-8")
    ) as JourneyResult;
    if (jr.journey && jr.journey.trim()) {
      const result = emitDelta({
        roots,
        wolf,
        denTopicId: `crawl-${plan.domain}-history`,
        change: "create",
        domainHint: plan.domain,
        summary: `Reconstructed timeline of ${plan.domain}${jr.from ? ` (${jr.from}–${jr.to})` : ""}.`,
        body: jr.journey,
        sourceCreated: jr.from,
        sourceUpdated: jr.to,
        dateBasis: "content",
        dateConfidence: jr.datedCount ? "high" : "none",
        currency: "archived",
        sourcePath: plan.source,
        origin: "crawl",
      });
      contributions.push({
        kind: "history",
        topic: "history",
        denTopicId: `crawl-${plan.domain}-history`,
        title: `${plan.domain} — reconstructed history`,
        summary: `Reconstructed timeline of ${plan.domain}${jr.from ? ` (${jr.from}–${jr.to})` : ""}.`,
        bodyChars: jr.journey.length,
        sourceCreated: jr.from,
        sourceUpdated: jr.to,
        currency: "archived",
        status: result ? "emit" : "skip",
      });
      if (result) {
        emitted++;
        sink.log(`emit: history → ${result.denTopicId}`);
      } else {
        skipped++;
      }
    }
  } catch {
    sink.log("emit: no history.json — skipping history entry");
  }

  const dest = `${opsRoot}/inbox/${wolf}`;
  sink.log(`emit done: ${emitted} emitted, ${skipped} unchanged → ${dest}`);
  if (!opts.quiet) {
    console.log(
      `\n${emitted} contribution(s) ${opts.dryRun ? "rendered (dry-run)" : "emitted"} → ${dest}` +
        `\nLog: ${sink.dir}`
    );
  }
  return { emitted, skipped, dest, dir: sink.dir, contributions };
}
