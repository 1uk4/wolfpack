/**
 * Wolf consolidator — the core pipeline.
 *
 * Takes a session's OM memory and promotes it into the wolf's den, then emits
 * contribution deltas to the shared KB. Deterministic — no LLM in this stage.
 *
 * The den is PRIVATE working memory; the KB (Dewey's sweep) is the curated truth
 * and owns merging/clustering/relations. So we do NOT read the whole den or run
 * a model to merge against it here. We upsert session topics by stable slug id
 * and let the KB registry do the scalable merge.
 *
 * Flow:
 *   1. Read session topics (OM output); bail if none / already consolidated
 *   2. Upsert each session topic into the den by id (create or update)
 *   3. emitDelta each to the Librarian inbox (hash-guarded, no LLM)
 *   4. Update den journey
 *   5. Regenerate den index
 *   6. Mark session as consolidated
 */
import type { Engine } from "@wolfpack/engine";
import { emitDelta } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readTopics, readJourney, type TopicFile } from "./session/memory.js";
import {
  readDenJourney,
  writeDenTopic,
  writeDenJourney,
  markSessionConsolidated,
  ensureDenDirs,
  type DenConfig,
} from "./den.js";
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
  /** Optional progress sink — called with human-readable status lines as the
   *  pipeline advances, so a UI can show what is actually being processed. */
  onProgress?: (msg: string) => void;
}

export interface ConsolidateResult {
  sessionId: string;
  topicsProcessed: number;
  topicsMerged: number;
  topicsCreated: number;
  topicsSkipped: number;
  claimsSubmitted: number;
  /** Per-topic outcomes for the topics that were written (create/merge). */
  details: Array<{ title: string; change: "create" | "merge" }>;
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
    onProgress,
  } = options;

  // NOTE: we intentionally do NOT bail when this session was promoted before.
  // Promotion is now a cheap, idempotent upsert (deterministic den write +
  // hash-guarded emitDelta), so re-promoting a long-lived session must pick up
  // whatever Stage-1 has consolidated SINCE the last promote. The old
  // session-level "already consolidated" guard existed only to avoid re-running
  // the expensive O(den) LLM merge, which no longer exists — and it silently
  // stranded every topic created after the first promote.
  ensureDenDirs(den.denRoot);

  // Step 1: Read session memory
  const sessionDir = join(memoryRoot, sessionId);
  const sessionTopics = readTopics(sessionDir);
  const sessionJourney = readJourney(sessionDir);
  if (sessionTopics.length === 0) {
    onProgress?.("no session topics to promote — nothing to do");
    markSessionConsolidated(den.denRoot, sessionId, 0);
    return {
      sessionId,
      topicsProcessed: 0,
      topicsMerged: 0,
      topicsCreated: 0,
      topicsSkipped: 0,
      claimsSubmitted: 0,
      details: [],
    };
  }

  // Step 2+3: Promote session topics into the den — DETERMINISTIC, no LLM.
  //
  // Architecture note: the den is this wolf's PRIVATE working copy; the shared
  // KB (Dewey's sweep) is the curated source of truth and already owns the real
  // work — clustering related topics, deriving relations (embeddings), and
  // maintaining the per-domain registry that maps each den topic → a canonical
  // topic. So promote no longer reads the whole den or asks a model to merge
  // against it (that was O(den) and unbounded). It upserts each session topic by
  // its stable slug id and emits a delta to the KB. Merging happens there, where
  // it scales. This makes promote O(session topics) and flat as the den grows.
  //
  // No data is lost by not merging den-side: emitDelta records every body as a
  // hash-chained contribution in the librarian inbox, so the KB retains full
  // history and produces the merged canonical entry.
  const topicsDir = join(den.denRoot, "memory", "topics");
  onProgress?.(`promoting ${sessionTopics.length} session topic(s) to den:`);

  let merged = 0;
  let created = 0;
  const skipped = 0;
  const updatedTopics: Array<{
    id: string;
    title: string;
    summary: string;
    body: string;
    change: "create" | "merge";
  }> = [];

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);

  for (const t of sessionTopics) {
    // "merge" = updating an existing den topic with the same id; "create" = new.
    const change: "create" | "merge" = existsSync(join(topicsDir, `${t.id}.md`))
      ? "merge"
      : "create";
    const topic = {
      id: t.id,
      title: t.title,
      summary: t.summary,
      updated: now,
      body: t.body,
    };

    writeDenTopic(den.denRoot, topic);
    updatedTopics.push({ ...topic, change });
    onProgress?.(`  ${change === "merge" ? "updated" : "created"}: ${t.title}`);

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
    details: updatedTopics.map((t) => ({ title: t.title, change: t.change })),
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
