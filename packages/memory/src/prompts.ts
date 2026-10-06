/**
 * Prompts for the wolf consolidator's LLM calls.
 * Each prompt maps to a specific pipeline step with a Zod schema output.
 */
import type { TopicFile } from "./session/memory.js";
import type { DenTopic } from "./den.js";

/**
 * System prompt for the CONSOLIDATE step.
 * Given session topics and existing den topics, produce merge instructions.
 */
export const CONSOLIDATE_SYSTEM = `You are a knowledge consolidator for a coding agent's persistent memory.

Your job: take topic files from a completed session and fold them into the wolf's permanent memory. The wolf's permanent memory persists across all sessions — it is the wolf's long-term knowledge about projects, decisions, and context.

You receive:
1. SESSION TOPICS — knowledge captured during one session (the new input)
2. DEN TOPICS — the wolf's existing permanent memory (what it already knows)

For each session topic, decide:
- MERGE — the session topic extends or updates an existing den topic. Produce the merged content.
- CREATE — the session topic covers something new. Produce the new topic.
- SKIP — the session topic is noise, too session-specific, or already fully covered.

Rules:
- Write current-state prose, not a changelog. If new info supersedes old info, REWRITE to reflect the new truth.
- Preserve distinguishing detail: file paths, identifiers, names, error codes, exact numbers.
- Keep prose tight and skimmable. Headings and short paragraphs are fine.
- The summary field is load-bearing — it's the ONLY thing the wolf sees until it opens the file. Make it specific and current.
- Strip session-specific context (timestamps, "today we", "just now"). This is permanent memory.

Respond with valid JSON matching the schema.`;

/**
 * Build the consolidation prompt with session topics and den topics.
 */
export function buildConsolidatePrompt(
  sessionTopics: TopicFile[],
  denTopics: DenTopic[]
): string {
  const sessionSection = sessionTopics
    .map(
      (t) =>
        `### ${t.id} — ${t.title}\nSummary: ${t.summary}\n\n${t.body}`
    )
    .join("\n\n---\n\n");

  const denSection =
    denTopics.length > 0
      ? denTopics
          .map(
            (t) =>
              `### ${t.id} — ${t.title}\nSummary: ${t.summary}\n\n${t.body}`
          )
          .join("\n\n---\n\n")
      : "(empty — no existing memory)";

  return [
    "===== SESSION TOPICS (new input from this session) =====",
    sessionSection,
    "===== END SESSION TOPICS =====",
    "",
    "===== DEN TOPICS (existing permanent memory) =====",
    denSection,
    "===== END DEN TOPICS =====",
    "",
    "Fold the session topics into permanent memory. For each session topic, decide MERGE, CREATE, or SKIP.",
  ].join("\n");
}

/**
 * System prompt for the JOURNEY UPDATE step.
 * Append to the wolf's running history.
 */
export const JOURNEY_SYSTEM = `You maintain a wolf's running project history — a short, purely descriptive narrative of how work has progressed across sessions.

You receive the current journey and a summary of what happened in the latest session. Append a short dated segment (2-5 sentences) describing the arc of this session. Do NOT include recommendations, next steps, or advice. Write only what happened, past tense.

If the journey would exceed the token budget, compress the OLDEST segments into a tighter summary, keeping recent history detailed.

Respond with the complete updated journey text (not JSON — plain markdown).`;
