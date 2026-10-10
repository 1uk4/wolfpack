/**
 * consolidate — per-batch rolling topic (spec §8). A crawl PRE-declares its
 * topics (the batches), so unlike live memory we call consolidation scoped to ONE
 * target topic: all of a batch's observations fold into one current-state rolling
 * document. Precision mirrors CONSOLIDATE_SYSTEM; the one addition is temporal
 * currency (supersede current state, preserve dated history) and the undated rule.
 *
 * LLM owns the prose; CODE owns the dates (stamped into frontmatter afterwards).
 */
import { z } from "zod";
import type { Engine } from "@wolfpack/engine";
import { CRAWL_CONSOLIDATE_SYSTEM, atomicWrite, DIGEST } from "@wolfpack/engine";
import {
  PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE,
  CRAWL_CONSOLIDATION_USER_PROMPT,
} from "../config/prompts/consolidations.js";
import { fillPromptTemplate } from "../config/prompts/template.js";
import { join } from "node:path";
import { ordersJourney } from "./dates.js";
import type { CrawlObservation } from "./extract.js";
import type { CrawlPlan, DatedFile, Currency, DateInfo } from "./schemas.js";
import type { CrawlSink } from "./sink.js";
import type { ContextDigest, DigestSection, RunningDigest } from "@wolfpack/kb/shared";

// ── LLM contract ──────────────────────────────────────────────────────────────

export const CrawlEventSchema = z.object({
  /** ISO date (YYYY-MM-DD / YYYY-MM / YYYY). Omit when the change has no date. */
  date: z.string().optional(),
  /** One-line, past-tense, factual decision or change. */
  change: z.string(),
});
export type CrawlEvent = z.infer<typeof CrawlEventSchema>;

export const CrawlTopicSchema = z.object({
  title: z.string().describe("Concise noun phrase naming the topic"),
  summary: z
    .string()
    .describe("One line (≤140 chars), specific and current — the load-bearing index line")
    .transform((s) => (s.length > 140 ? s.slice(0, 139) + "…" : s)),
  body: z.string().describe("Current-state markdown ONLY — no timeline/history narrative"),
  /** Dated decisions/changes — the raw material for the domain journey. */
  events: z.array(CrawlEventSchema).optional(),
});
export type CrawlTopic = z.infer<typeof CrawlTopicSchema>;

// ── Running digest (crawl-specific) ──────────────────────────────────────────

/**
 * Render a "PACK ALREADY KNOWS" block from digest sections for crawl prompts.
 * Keeps it lean: sectionId, title, summary only (no bodies).
 * Respects DIGEST.maxPrimedTopics cap from engine tuning.
 */
function renderPackKnows(sections: DigestSection[]): string {
  const capped = sections.slice(0, DIGEST.maxPrimedTopics);
  if (capped.length === 0) return "";
  
  const lines = capped.map(
    (s) => `- ${s.sectionId} — ${s.title}\n  ${s.summary}`
  );
  return fillPromptTemplate(PACK_ALREADY_KNOWS_RUNNING_DIGEST_TEMPLATE, {
    sectionLines: lines.join("\n\n"),
  });
}

/**
 * Merge a published digest with sections produced so far in this crawl run.
 * Union sections by sectionId (fallback: entryIds intersection check).
 * `produced` wins (it is fresher within the run).
 * Returns a RunningDigest.
 */
export function mergeRunningDigest(
  published: ContextDigest,
  produced: DigestSection[]
): RunningDigest {
  // Build a map of produced sections by sectionId
  const producedMap = new Map<string, DigestSection>();
  for (const section of produced) {
    producedMap.set(section.sectionId, section);
  }
  
  // Flatten all sections from published (depth-first)
  function flattenSections(sections: DigestSection[]): DigestSection[] {
    const result: DigestSection[] = [];
    for (const section of sections) {
      result.push(section);
      if (section.children.length > 0) {
        result.push(...flattenSections(section.children));
      }
    }
    return result;
  }
  
  const publishedFlat = flattenSections(published.sections);
  
  // Merge: produced sections + non-overlapping published sections
  const mergedSections: DigestSection[] = [...produced];
  for (const pubSection of publishedFlat) {
    if (!producedMap.has(pubSection.sectionId)) {
      // Check for entryId overlap as fallback (shouldn't usually happen but be safe)
      const hasEntryOverlap = pubSection.entryIds.some(entryId =>
        produced.some(p => p.entryIds.includes(entryId))
      );
      if (!hasEntryOverlap) {
        mergedSections.push(pubSection);
      }
    }
  }
  
  return {
    ...published,
    sections: mergedSections,
  };
}

export function buildCrawlConsolidatePrompt(
  topic: string,
  currency: Currency,
  observations: CrawlObservation[],
  existing?: string,
  digest?: RunningDigest | DigestSection[]
): string {
  const obsLines = observations
    .map((o) => `${o.timestamp && o.timestamp.trim() ? o.timestamp : "undated"}  ${o.content}`)
    .join("\n");
  
  // Extract sections from digest if provided (handle both RunningDigest and sections array)
  const sections = digest
    ? Array.isArray(digest)
      ? digest
      : digest.sections
    : [];
  const packKnowsBlock = renderPackKnows(sections);
  
  const existingBlock = existing
    ? `===== EXISTING ENTRY (extend this) =====\n${existing}\n===== END EXISTING =====\n`
    : "(no existing entry — create fresh)";

  return fillPromptTemplate(CRAWL_CONSOLIDATION_USER_PROMPT, {
    topic,
    currency,
    obsLines,
    existingBlock,
    packKnowsBlock,
  });
}

export async function consolidateBatch(
  engine: Engine,
  args: {
    topic: string;
    currency: Currency;
    observations: CrawlObservation[];
    existing?: string;
    digest?: RunningDigest | DigestSection[];
  }
): Promise<CrawlTopic> {
  return engine.call("consolidate", CrawlTopicSchema, {
    system: CRAWL_CONSOLIDATE_SYSTEM,
    prompt: buildCrawlConsolidatePrompt(
      args.topic,
      args.currency,
      args.observations,
      args.existing,
      args.digest
    ),
  });
}

// ── Temporal stamping (code owns dates) ─────────────────────────────────────

export interface TopicTemporal {
  sourceCreated?: string;
  sourceUpdated?: string;
  dateBasis: DateInfo["basis"];
  dateConfidence: DateInfo["confidence"];
}

const BASIS_RANK: Record<DateInfo["basis"], number> = {
  frontmatter: 5,
  git: 4,
  filename: 3,
  content: 2,
  mtime: 1,
  none: 0,
};

/** Derive the batch's temporal block from its files' resolved dates. */
export function computeTemporal(files: DatedFile[]): TopicTemporal {
  const grounded = files.filter((f) => ordersJourney(f.dateInfo) && f.dateInfo.date);
  const dates = grounded.map((f) => f.dateInfo.date!).sort();
  // Representative basis = the highest-ranked basis among grounded files.
  let basis: DateInfo["basis"] = "none";
  for (const f of grounded) {
    if (BASIS_RANK[f.dateInfo.basis] > BASIS_RANK[basis]) basis = f.dateInfo.basis;
  }
  const confidence: DateInfo["confidence"] = grounded.length ? "high" : "none";
  return {
    sourceCreated: dates[0],
    sourceUpdated: dates[dates.length - 1],
    dateBasis: basis,
    dateConfidence: confidence,
  };
}

/** Sort events chronologically; undated last. */
export function sortEvents(events: CrawlEvent[]): CrawlEvent[] {
  return [...events].sort((a, b) => {
    if (a.date && b.date) return a.date.localeCompare(b.date);
    if (a.date) return -1;
    if (b.date) return 1;
    return a.change.localeCompare(b.change);
  });
}

/** Render a "## Decisions & Changes" section from the structured events. */
export function renderDecisions(events: CrawlEvent[]): string {
  if (!events.length) return "";
  const rows = sortEvents(events).map(
    (e) => `- **${e.date ?? "undated"}** — ${e.change}`
  );
  return `\n\n## Decisions & Changes\n${rows.join("\n")}`;
}

/** Render the staged topic markdown (frontmatter + current-state body + decisions). */
export function renderTopicDoc(
  batchId: string,
  topic: CrawlTopic,
  temporal: TopicTemporal,
  currency: Currency,
  sourcePath: string
): string {
  const fm = [
    "---",
    `id: ${batchId}`,
    `title: ${topic.title}`,
    `summary: ${topic.summary}`,
    temporal.sourceCreated ? `source_created: ${temporal.sourceCreated}` : null,
    temporal.sourceUpdated ? `source_updated: ${temporal.sourceUpdated}` : null,
    `date_basis: ${temporal.dateBasis}`,
    `date_confidence: ${temporal.dateConfidence}`,
    `currency: ${currency}`,
    `source_path: ${sourcePath}`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return `${fm}\n\n${topic.body}${renderDecisions(topic.events ?? [])}\n`;
}

/** Consolidate every batch (oldest→newest) and write /tmp/topics/<batch>.md. */
export async function consolidateCrawl(
  engine: Engine,
  plan: CrawlPlan,
  observationsByBatch: Map<string, CrawlObservation[]>,
  datedByPath: Map<string, DatedFile>,
  sink: CrawlSink,
  publishedDigest?: ContextDigest
): Promise<Map<string, CrawlTopic>> {
  const result = new Map<string, CrawlTopic>();
  const producedSections: DigestSection[] = [];
  
  for (const b of plan.batches) {
    const obs = observationsByBatch.get(b.topic) ?? [];
    if (obs.length === 0) {
      sink.log(`consolidate: ${b.topic} — 0 observations, skipped`);
      continue;
    }
    const currency = b.currency ?? plan.currency;
    
    // Build running digest for this batch: published + produced sections from batches 1..N-1
    const runningDigest = publishedDigest
      ? mergeRunningDigest(publishedDigest, producedSections)
      : undefined;
    
    const topic = await sink.heartbeat(
      `consolidating ${b.topic} (${obs.length} obs)`,
      () => consolidateBatch(engine, { 
        topic: b.topic, 
        currency, 
        observations: obs,
        digest: runningDigest 
      })
    );

    const files = b.files
      .map((rel) => datedByPath.get(rel))
      .filter((f): f is DatedFile => !!f);
    const temporal = computeTemporal(files);
    const batchId = `crawl-${plan.domain}-${b.topic}`;
    const doc = renderTopicDoc(batchId, topic, temporal, currency, plan.source);

    sink.file(join("topics", `${b.topic}.md`), doc);
    sink.log(
      `consolidate: ${b.topic} — ${obs.length} obs → topic "${topic.title}" ` +
        `[${temporal.sourceCreated ?? "?"}..${temporal.sourceUpdated ?? "?"} ${temporal.dateBasis}/${temporal.dateConfidence}]`
    );
    result.set(b.topic, topic);
    
    // Add this batch's topic to produced sections for the next batch's running digest
    producedSections.push({
      sectionId: batchId,
      title: topic.title,
      summary: topic.summary,
      currency: currency === "live" ? "live" : currency === "snapshot" ? "snapshot" : "archived",
      entryIds: [batchId],
      children: [],
    });
  }
  return result;
}
