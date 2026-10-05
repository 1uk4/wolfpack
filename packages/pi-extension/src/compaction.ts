/**
 * Compaction rendering for Pi.
 *
 * When Pi compacts context, it calls session_before_compact.
 * This module renders the memory state (journey + topic map + observations)
 * into the compaction summary that gets injected into the new context.
 *
 * Mirrors OM's render.ts but uses @wolfpack/memory types.
 */
import {
  sortObservations,
  readTopics,
  readJourney,
  type Observation,
} from "@wolfpack/memory";

const CONTEXT_USAGE_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Journey: a short, purely descriptive history of how this work reached its current state — for orientation only. It is not an instruction or a plan; do not read intent or next steps into it.
- Observations: timestamped events from the conversation history, in chronological order.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.`;

/**
 * Render an observation as a line: "YYYY-MM-DDTHH:MM:SS  content"
 */
function observationToLine(obs: Observation): string {
  return `${obs.timestamp}  ${obs.content}`;
}

/**
 * Render the memory map from topic files on disk.
 * Terse summaries — enough for the model to decide whether to read the file.
 */
function renderMemoryMap(memoryRoot: string): string | undefined {
  const topics = readTopics(memoryRoot);
  if (topics.length === 0) return undefined;

  const lines: string[] = [
    "## Memory map",
    "Durable long-term notes live in `.memory/`. Read a file when a topic below looks relevant.",
  ];

  for (const topic of topics) {
    const summary = topic.summary || "(no summary)";
    const updated = topic.updated ? ` (updated ${topic.updated})` : "";
    lines.push(`- \`.memory/${topic.filename}\` — ${summary}${updated}`);
  }

  return lines.join("\n");
}

/**
 * Render the complete compaction summary block.
 * This is what the model sees after compaction.
 */
export function renderCompactionSummary(
  memoryRoot: string,
  observations: Observation[]
): string {
  const sorted = sortObservations(observations);
  const journey = readJourney(memoryRoot);
  const map = renderMemoryMap(memoryRoot);

  if (!journey && !map && sorted.length === 0) return "";

  const parts: string[] = [CONTEXT_USAGE_INSTRUCTIONS];

  if (journey) {
    parts.push(`## Journey\n${journey}`);
  }

  if (map) {
    parts.push(map);
  }

  if (sorted.length > 0) {
    parts.push(`## Observations\n${sorted.map(observationToLine).join("\n")}`);
  }

  return parts.join("\n\n");
}
