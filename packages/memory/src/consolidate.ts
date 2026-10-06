/**
 * Wolf consolidator — the core pipeline.
 *
 * Takes a session's OM memory and folds it into the wolf's den.
 * Optionally auto-submits claims to the Librarian.
 *
 * Flow:
 *   1. Read session topics (OM output)
 *   2. Read existing den topics
 *   3. LLM: consolidate (merge/create/skip for each session topic)
 *   4. Write updated den topics
 *   5. LLM: check if anything is claim-worthy
 *   6. Write claims to Librarian inbox
 *   7. Update den journey
 *   8. Regenerate den index
 *   9. Mark session as consolidated
 */
import type { Engine } from "@wolfpack/engine";
import { emitDelta } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { join } from "node:path";
import { readTopics, readJourney, type TopicFile } from "./session/memory.js";
import {
  readDenTopics,
  readDenJourney,
  writeDenTopic,
  writeDenJourney,
  markSessionConsolidated,
  getConsolidatedSessions,
  ensureDenDirs,
  type DenConfig,
} from "./den.js";
import {
  CONSOLIDATE_SYSTEM,
  JOURNEY_SYSTEM,
  buildConsolidatePrompt,
} from "./prompts.js";
import { ConsolidationResultSchema, type ConsolidationResult } from "./schemas.js";
import { renderDenIndex } from "./den-index.js";

export interface ConsolidateOptions {
  /** The engine instance (with provider + model config) */
  engine: Engine;
  /** Wolf den configuration */
  den: DenConfig;
  /** Path to .memory/ root (project-level) */
  memoryRoot: string;
  /** Session ID to consolidate */
  sessionId: string;
  /** KB storage roots; enables emitting contribution deltas to the librarian. */
  kbRoots?: KbRoots;
  /** Default domain hint for emitted deltas (e.g. "snapjack", "wolfpack"). */
  defaultDomain?: string;
  /** Skip emitting deltas to the KB. */
  skipClaims?: boolean;
}

export interface ConsolidateResult {
  sessionId: string;
  topicsProcessed: number;
  topicsMerged: number;
  topicsCreated: number;
  topicsSkipped: number;
  claimsSubmitted: number;
}

/**
 * Run the wolf consolidation pipeline for a single session.
 */
export async function consolidateSession(
  options: ConsolidateOptions
): Promise<ConsolidateResult> {
  const {
    engine,
    den,
    memoryRoot,
    sessionId,
    kbRoots,
    defaultDomain = "wolfpack",
    skipClaims = false,
  } = options;

  // Check if already consolidated
  const consolidated = getConsolidatedSessions(den.denRoot);
  if (consolidated.some((s) => s.sessionId === sessionId)) {
    return {
      sessionId,
      topicsProcessed: 0,
      topicsMerged: 0,
      topicsCreated: 0,
      topicsSkipped: 0,
      claimsSubmitted: 0,
    };
  }

  ensureDenDirs(den.denRoot);

  // Step 1: Read session memory
  const sessionDir = join(memoryRoot, sessionId);
  const sessionTopics = readTopics(sessionDir);
  const sessionJourney = readJourney(sessionDir);
  if (sessionTopics.length === 0) {
    markSessionConsolidated(den.denRoot, sessionId, 0);
    return {
      sessionId,
      topicsProcessed: 0,
      topicsMerged: 0,
      topicsCreated: 0,
      topicsSkipped: 0,
      claimsSubmitted: 0,
    };
  }

  // Step 2: Read existing den topics
  const denTopics = readDenTopics(den.denRoot);

  // Step 3: LLM — consolidate
  const consolidation = await engine.call(
    "consolidate",
    ConsolidationResultSchema,
    {
      system: CONSOLIDATE_SYSTEM,
      prompt: buildConsolidatePrompt(sessionTopics, denTopics),
    }
  );

  // Step 4: Write results to den
  let merged = 0;
  let created = 0;
  let skipped = 0;
  const updatedTopics: Array<{
    id: string;
    title: string;
    summary: string;
    body: string;
    change: "create" | "merge";
  }> = [];

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);

  for (const action of consolidation.actions) {
    if (action.action === "skip" || !action.result) {
      skipped++;
      continue;
    }

    const topic = {
      id: action.result.id,
      title: action.result.title,
      summary: action.result.summary,
      updated: now,
      body: action.result.body,
    };

    writeDenTopic(den.denRoot, topic);
    const change = action.action === "merge" ? "merge" : "create";
    updatedTopics.push({ ...topic, change });

    if (change === "merge") merged++;
    else created++;
  }

  // Step 5: Emit contribution deltas to the KB (deterministic, NO LLM).
  // The wolf just reports what changed about each den topic; Dewey's sweep
  // decides whether/where it lands. Hash-guarded, so unchanged re-promotes
  // are no-ops.
  let claimsSubmitted = 0;

  if (!skipClaims && kbRoots && updatedTopics.length > 0) {
    for (const topic of updatedTopics) {
      const emitted = emitDelta({
        roots: kbRoots,
        wolf: den.wolfName,
        denTopicId: topic.id,
        change: topic.change,
        domainHint: defaultDomain,
        summary: topic.summary,
        body: topic.body,
        session: sessionId,
      });
      if (emitted) claimsSubmitted++;
    }
  }

  // Step 6: Update journey
  if (sessionJourney) {
    const currentJourney = readDenJourney(den.denRoot);
    const updatedJourney = await updateJourney(
      engine,
      currentJourney,
      sessionJourney
    );
    writeDenJourney(den.denRoot, updatedJourney);
  }

  // Step 7: Regenerate den index
  renderDenIndex(den.denRoot);

  // Step 8: Mark consolidated
  markSessionConsolidated(den.denRoot, sessionId, sessionTopics.length);

  return {
    sessionId,
    topicsProcessed: sessionTopics.length,
    topicsMerged: merged,
    topicsCreated: created,
    topicsSkipped: skipped,
    claimsSubmitted,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function updateJourney(
  engine: Engine,
  currentJourney: string | null,
  sessionJourney: string
): Promise<string> {
  // For now, append the session journey to the den journey.
  // Use the LLM to merge and compress if we want to get fancy later.
  const current = currentJourney ?? "";
  const date = new Date().toISOString().split("T")[0];

  // Simple append for v1 — the LLM journey update can be added when needed
  const segment = `\n## ${date}\n${sessionJourney}\n`;
  return (current + segment).trim();
}
