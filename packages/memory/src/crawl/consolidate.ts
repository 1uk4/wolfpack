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
import { CRAWL_CONSOLIDATE_SYSTEM, DIGEST } from "@wolfpack/engine";
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

/**
 * Running digest for one crawl: the published domain digest (what the pack
 * already knows) plus the topics this crawl has produced so far, so later
 * batches extend earlier ones instead of restating them. With parallel
 * batches, "so far" means batches that have already finished.
 */
export function createRunningDigest(domain: string, published?: ContextDigest) {
  const base: ContextDigest = published ?? {
    domain,
    generated: "",
    vocabulary: { kinds: [], facetKeys: [], relationKinds: [] },
    sections: [],
    gaps: [],
  };
  const produced: DigestSection[] = [];
  return {
    /** Snapshot to prime the next batch; undefined when there is nothing yet. */
    current(): RunningDigest | undefined {
      return published || produced.length ? mergeRunningDigest(base, produced) : undefined;
    },
    /** Record a finished batch; a rerun of the same batch replaces its section. */
    add(batchId: string, topic: CrawlTopic, currency: Currency): void {
      const i = produced.findIndex((s) => s.sectionId === batchId);
      if (i >= 0) produced.splice(i, 1);
      produced.push({
        sectionId: batchId,
        title: topic.title,
        summary: topic.summary,
        currency,
        entryIds: [batchId],
        children: [],
      });
    },
  };
}
export type RunningDigestState = ReturnType<typeof createRunningDigest>;

/**
 * Consolidate ONE batch into its topic: digest-primed LLM fold, then stamp
 * dates and write topics/<topic>.md. The single implementation shared by
 * `run` (parallel, per batch) and `resume` (from saved observations).
 */
export async function consolidateTopic(
  engine: Engine,
  args: {
    plan: CrawlPlan;
    topic: string;
    currency: Currency;
    observations: CrawlObservation[];
    files: DatedFile[];
    sink: CrawlSink;
    digest?: RunningDigestState;
  }
): Promise<CrawlTopic> {
  const { plan, topic: name, currency, observations, files, sink, digest } = args;
  const topic = await sink.heartbeat(`consolidating ${name} (${observations.length} obs)`, () =>
    engine.call("consolidate", CrawlTopicSchema, {
      system: CRAWL_CONSOLIDATE_SYSTEM,
      prompt: buildCrawlConsolidatePrompt(name, currency, observations, undefined, digest?.current()),
    })
  );
  const temporal = computeTemporal(files);
  const batchId = `crawl-${plan.domain}-${name}`;
  sink.file(join("topics", `${name}.md`), renderTopicDoc(batchId, topic, temporal, currency, plan.source));
  sink.log(
    `consolidate: ${name} — ${observations.length} obs → topic "${topic.title}" ` +
      `[${temporal.sourceCreated ?? "?"}..${temporal.sourceUpdated ?? "?"} ${temporal.dateBasis}/${temporal.dateConfidence}]`
  );
  digest?.add(batchId, topic, currency);
  return topic;
}
