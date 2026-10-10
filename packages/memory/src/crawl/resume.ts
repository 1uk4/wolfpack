/**
 * resume — re-run the cheap LLM stages against a prior run's saved artifacts.
 *   from "observations" (default): re-consolidate + journey from observations.jsonl
 *   from "topics":                 re-journey only from topics.json
 * Writes a fresh resume-<ts> run dir; the source run dir is left untouched.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverSources } from "./discover.js";
import { readPlan, writePlan } from "./plan.js";
import { createSink } from "./sink.js";
import { consolidateTopic, createRunningDigest, type CrawlTopic } from "./consolidate.js";
import type { CrawlObservation } from "./extract.js";
import type { DatedFile } from "./schemas.js";
import {
  createCrawlEngine,
  datedByPath,
  loadPublishedDigest,
  topicsInPlanOrder,
  journeyTail,
  mapWithConcurrencyLimit,
  DEFAULT_CRAWL_CONCURRENCY,
} from "./run.js";

export async function resumeCrawl(
  runDir: string,
  opts: { from?: "observations" | "topics"; sinkBase?: string } = {}
): Promise<{ dir: string }> {
  const from = opts.from ?? "observations";
  const plan = readPlan(join(runDir, "plan.yaml"));
  const sink = createSink(`resume-${Date.now()}`, opts.sinkBase);
  sink.log(`resume start: from=${from} src=${runDir} domain=${plan.domain}`);
  writePlan(join(sink.dir, "plan.yaml"), plan);
  const { engine, smartModel } = createCrawlEngine();

  if (from === "topics") {
    const entries = JSON.parse(
      readFileSync(join(runDir, "topics.json"), "utf-8")
    ) as [string, CrawlTopic][];
    const topics = new Map(entries);
    sink.log(`loaded ${topics.size} topic(s) from topics.json`);
    await journeyTail(engine, plan, topics, sink, smartModel);
    return { dir: sink.dir };
  }

  // from observations: regroup saved observations, re-consolidate + journey.
  const rawObs = readFileSync(join(runDir, "observations.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CrawlObservation);
  const obsByBatch = new Map<string, CrawlObservation[]>();
  for (const o of rawObs) {
    (obsByBatch.get(o.batch) ?? obsByBatch.set(o.batch, []).get(o.batch)!).push(o);
  }
  sink.log(`loaded ${rawObs.length} observation(s) across ${obsByBatch.size} batch(es)`);

  const byPath = datedByPath(
    plan,
    discoverSources(plan.source, { include: plan.include, exclude: plan.exclude })
  );
  const published = loadPublishedDigest(plan.domain);
  const digest = createRunningDigest(plan.domain, published);
  sink.log(
    `consolidate: ${plan.batches.length} batch(es) on ${smartModel}` +
      (published ? ` (digest-primed)` : "")
  );

  const topicByName = new Map<string, CrawlTopic>();
  await mapWithConcurrencyLimit(plan.batches, DEFAULT_CRAWL_CONCURRENCY, async (b) => {
    const observations = obsByBatch.get(b.topic) ?? [];
    if (observations.length === 0) {
      sink.log(`consolidate: ${b.topic} — 0 observations, skipped`);
      return;
    }
    const topic = await consolidateTopic(engine, {
      plan,
      topic: b.topic,
      currency: b.currency ?? plan.currency,
      observations,
      files: b.files.map((rel) => byPath.get(rel)).filter((f): f is DatedFile => !!f),
      sink,
      digest,
    });
    topicByName.set(b.topic, topic);
  });

  const topics = topicsInPlanOrder(plan, topicByName);
  sink.log(`consolidate done: ${topics.size} topic(s) → topics/`);
  await journeyTail(engine, plan, topics, sink, smartModel);
  return { dir: sink.dir };
}
