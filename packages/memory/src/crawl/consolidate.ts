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
import { atomicWrite } from "@wolfpack/engine";
import { join } from "node:path";
import { ordersJourney } from "./dates.js";
import type { CrawlObservation } from "./extract.js";
import type { CrawlPlan, DatedFile, Currency, DateInfo } from "./schemas.js";
import type { CrawlSink } from "./sink.js";

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

export const CRAWL_CONSOLIDATE_SYSTEM = `You are a knowledge consolidator for a shared knowledge base.

You receive timestamped observations that ALL belong to ONE topic, extracted from
historical documents. Fold them into ONE current-state knowledge entry. You may
also receive the EXISTING entry for this topic (from a previous pass) — extend it.

Produce: a title, a load-bearing one-line summary, a current-state body, and a
list of dated events.

BODY rules (what is true NOW):
- Write current-state prose. When a later observation supersedes an earlier one,
  REWRITE to the new truth and DELETE the obsolete statement. No "was X, now Y".
- Do NOT include a timeline, changelog, or chronological narrative in the body —
  that is built separately from the events list below. The body describes the
  present state only.
- Preserve distinguishing detail verbatim: file paths, identifiers, API routes,
  names, error codes, exact numbers with units, version numbers.
- Keep facts atomic and skimmable. Short sections and bullets. No preamble.
- Flag contradictions rather than resolving them silently (e.g. "CONFLICT — …").
- Undated facts that describe current state: just state them. If a fact cannot be
  placed, keep it under a brief "## Undated" note. NEVER invent a date.

EVENTS rules (how it changed — the raw material for the project history):
- Emit one event for each DECISION or CHANGE the observations record: adoptions,
  renames, launches, migrations, deletions, parameter/scope changes, commits.
- Each event: a one-line, past-tense, factual "change", plus its "date" (YYYY-MM-DD,
  or YYYY-MM / YYYY when coarser). Omit "date" only when truly unknown.
- Events are NOT specifications. Do NOT emit an event for every schema field,
  parameter, or API route — those belong in the body. An event is something that
  HAPPENED, not something that merely IS.
- Preserve identifiers and numbers verbatim in events too.

The summary is the ONLY thing seen before the entry is opened — make it specific
and current. Respond with valid JSON matching the schema.`;

export function buildCrawlConsolidatePrompt(
  topic: string,
  currency: Currency,
  observations: CrawlObservation[],
  existing?: string
): string {
  const obsLines = observations
    .map((o) => `${o.timestamp && o.timestamp.trim() ? o.timestamp : "undated"}  ${o.content}`)
    .join("\n");
  return [
    `TOPIC: ${topic}`,
    `CURRENCY: ${currency}  (archived/snapshot = historical; present as of its dates)`,
    "",
    "===== OBSERVATIONS (all belong to this ONE topic) =====",
    obsLines,
    "===== END OBSERVATIONS =====",
    "",
    existing
      ? `===== EXISTING ENTRY (extend this) =====\n${existing}\n===== END EXISTING =====\n`
      : "(no existing entry — create fresh)",
    "",
    "Fold the observations into ONE current-state entry. Respond with JSON.",
  ].join("\n");
}

export async function consolidateBatch(
  engine: Engine,
  args: {
    topic: string;
    currency: Currency;
    observations: CrawlObservation[];
    existing?: string;
  }
): Promise<CrawlTopic> {
  return engine.call("consolidate", CrawlTopicSchema, {
    system: CRAWL_CONSOLIDATE_SYSTEM,
    prompt: buildCrawlConsolidatePrompt(
      args.topic,
      args.currency,
      args.observations,
      args.existing
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
  sink: CrawlSink
): Promise<Map<string, CrawlTopic>> {
  const result = new Map<string, CrawlTopic>();
  for (const b of plan.batches) {
    const obs = observationsByBatch.get(b.topic) ?? [];
    if (obs.length === 0) {
      sink.log(`consolidate: ${b.topic} — 0 observations, skipped`);
      continue;
    }
    const currency = b.currency ?? plan.currency;
    const topic = await sink.heartbeat(
      `consolidating ${b.topic} (${obs.length} obs)`,
      () => consolidateBatch(engine, { topic: b.topic, currency, observations: obs })
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
  }
  return result;
}
