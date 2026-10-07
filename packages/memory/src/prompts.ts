/**
 * Prompts for the wolf consolidator's LLM calls.
 * System prompts are imported from @wolfpack/engine.
 * This file provides the dynamic prompt builders.
 */
import type { TopicFile } from "./session/memory.js";
import type { DenTopic } from "./den.js";
import { CONSOLIDATE_SYSTEM, JOURNEY_SYSTEM } from "@wolfpack/engine";
import type { ContextDigest, DigestSection } from "@wolfpack/kb/shared";
import { DIGEST } from "@wolfpack/engine";

// Re-export for backward compatibility
export { CONSOLIDATE_SYSTEM, JOURNEY_SYSTEM };

/**
 * Render a "PACK ALREADY KNOWS" block from digest sections.
 * Keeps it lean: sectionId, title, summary only (no bodies).
 * Respects DIGEST.maxPrimedTopics cap from engine tuning.
 */
function renderPackKnows(sections: DigestSection[]): string {
  const capped = sections.slice(0, DIGEST.maxPrimedTopics);
  if (capped.length === 0) return "";
  
  const lines = capped.map(
    (s) => `- ${s.sectionId} — ${s.title}\n  ${s.summary}`
  );
  return [
    "",
    "===== PACK ALREADY KNOWS (shared KB context) =====",
    lines.join("\n\n"),
    "===== END PACK ALREADY KNOWS =====",
    "",
  ].join("\n");
}

/**
 * Build the consolidation prompt with session topics and den topics.
 * Uses CONSOLIDATE_SYSTEM from @wolfpack/engine.
 * Optionally primes with a subset of the shared KB digest.
 */
export function buildConsolidatePrompt(
  sessionTopics: TopicFile[],
  denTopics: DenTopic[],
  digest?: ContextDigest | DigestSection[]
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

  // Extract sections from digest if provided (handle both full digest and sections array)
  const sections = digest
    ? Array.isArray(digest)
      ? digest
      : digest.sections
    : [];
  const packKnowsBlock = renderPackKnows(sections);

  return [
    "===== SESSION TOPICS (new input from this session) =====",
    sessionSection,
    "===== END SESSION TOPICS =====",
    "",
    "===== DEN TOPICS (existing permanent memory) =====",
    denSection,
    "===== END DEN TOPICS =====",
    packKnowsBlock,
    "Fold the session topics into permanent memory. For each session topic, decide MERGE, CREATE, or SKIP.",
  ].join("\n");
}
