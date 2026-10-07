/**
 * journey — the reconstructed arc (spec §9). While topics answer "what is true
 * now", the journey answers "how it got here": a dated, chronological, past-tense
 * narrative.
 *
 * It is built from the CONSOLIDATED layer — each topic's structured dated events
 * (decisions/changes) — NOT raw observations. This mirrors live memory (the
 * journey summarizes consolidated session summaries, not individual observations),
 * keeps the input event-level instead of spec-level, and scales: a corpus with
 * thousands of observations still yields only a handful of events per topic.
 *
 * LLM owns the prose; CODE owns the ordering, the date range, and the undated note.
 */
import { z } from "zod";
import type { Engine } from "@wolfpack/engine";
import { CRAWL_JOURNEY_SYSTEM } from "@wolfpack/engine";
import { normalizeDate } from "./dates.js";
import type { CrawlTopic, CrawlEvent } from "./consolidate.js";
import type { CrawlPlan } from "./schemas.js";
import type { CrawlSink } from "./sink.js";

export const JourneyResultSchema = z.object({
  journey: z.string().describe("The full, updated markdown journey (chronological)"),
});

// Re-export from @wolfpack/engine
export { CRAWL_JOURNEY_SYSTEM };

export function buildJourneyPrompt(
  domain: string,
  current: string,
  eventLines: string
): string {
  return [
    `DOMAIN: ${domain}`,
    "",
    current
      ? `===== CURRENT JOURNEY (extend this) =====\n${current}\n===== END CURRENT JOURNEY =====`
      : "(no journey yet — begin it)",
    "",
    "===== NEW EVENTS (chronological, oldest first) =====",
    eventLines,
    "===== END EVENTS =====",
    "",
    "Extend the journey with these events. Narrate what changed; do not list specifications. Respond with JSON.",
  ].join("\n");
}

export interface JourneyResult {
  journey: string;
  datedCount: number;
  undatedCount: number;
  from?: string;
  to?: string;
}

interface DatedEvent {
  date: string;
  change: string;
  topic: string;
}

/**
 * Build the journey from all topics' dated events, rolling it forward in
 * chronological chunks. Writes /tmp/journey.md.
 */
export async function buildJourney(
  engine: Engine,
  plan: CrawlPlan,
  topicsByBatch: Map<string, CrawlTopic>,
  sink: CrawlSink,
  opts: { chunkSize?: number } = {}
): Promise<JourneyResult> {
  const chunkSize = opts.chunkSize ?? 150;

  const dated: DatedEvent[] = [];
  let undatedCount = 0;
  for (const [topic, t] of topicsByBatch) {
    for (const e of t.events ?? []) {
      const d = e.date ? normalizeDate(e.date) : undefined;
      if (d) dated.push({ date: d, change: e.change, topic });
      else undatedCount++;
    }
  }
  dated.sort((a, b) => a.date.localeCompare(b.date) || a.change.localeCompare(b.change));

  sink.log(`journey: ${dated.length} dated event(s), ${undatedCount} undated`);
  // Persist the raw event timeline for inspection.
  sink.file(
    "events.json",
    JSON.stringify(dated, null, 2)
  );

  if (dated.length === 0) {
    const empty = `# ${plan.domain} — history\n\n(No dated events; a timeline could not be reconstructed.)\n`;
    sink.file("journey.md", empty);
    return { journey: empty, datedCount: 0, undatedCount };
  }

  let journey = "";
  for (let i = 0; i < dated.length; i += chunkSize) {
    const slice = dated.slice(i, i + chunkSize);
    const eventLines = slice.map((e) => `${e.date}  ${e.change}`).join("\n");
    const { journey: updated } = await sink.heartbeat(
      `journey chunk ${Math.floor(i / chunkSize) + 1}`,
      () =>
        engine.call("consolidate", JourneyResultSchema, {
          system: CRAWL_JOURNEY_SYSTEM,
          prompt: buildJourneyPrompt(plan.domain, journey, eventLines),
        })
    );
    journey = updated.trim();
    sink.log(
      `journey: folded ${Math.min(i + chunkSize, dated.length)}/${dated.length} events`
    );
  }

  if (undatedCount > 0) {
    journey +=
      `\n\n## Undated\n${undatedCount} decision(s)/change(s) carried no date and ` +
      `are not placed on this timeline (see the topic entries).\n`;
  }

  sink.file("journey.md", journey + "\n");
  const from = dated[0].date;
  const to = dated[dated.length - 1].date;
  sink.log(`journey done: ${from} → ${to}`);
  return { journey, datedCount: dated.length, undatedCount, from, to };
}

/** Render the per-domain history entry (staged like a topic; emitted in step 6). */
export function renderHistoryDoc(
  domain: string,
  result: JourneyResult
): string {
  const fm = [
    "---",
    `id: crawl-${domain}-history`,
    `title: ${domain} — history`,
    `summary: Reconstructed timeline of ${domain}${result.from ? ` (${result.from}–${result.to})` : ""}.`,
    result.from ? `source_created: ${result.from}` : null,
    result.to ? `source_updated: ${result.to}` : null,
    `date_basis: content`,
    `date_confidence: ${result.datedCount ? "high" : "none"}`,
    `currency: archived`,
    `history: true`,
    "---",
  ]
    .filter(Boolean)
    .join("\n");
  return `${fm}\n\n${result.journey}\n`;
}
