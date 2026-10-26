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
import { promoteTopics } from "./distill.js";
import { isSafeSegment, type KbRoots } from "@wolfpack/kb/shared";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readTopics, readJourney, type TopicFile } from "./session/memory.js";
import {
  readDenJourney,
  writeDenTopic,
  gateDenTopic,
  writeDenJourney,
  markSessionConsolidated,
  ensureDenDirs,
  type DenConfig,
} from "./den.js";
import { renderDenIndex } from "./den-index.js";
import { isAbsorbed, reconcileDen } from "./den-reconcile.js";

/** Den topics are working memory: past this size the consolidator is asked to split, and we log (no rejection). */
export const TOPIC_SOFT_CAP = 8000;

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
  /** Default domain hint for emitted deltas (a declared domain name). */
  defaultDomain?: string;
  /** Skip emitting deltas to the KB. */
  skipClaims?: boolean;
  /** Optional progress sink — called with human-readable status lines as the
   *  pipeline advances, so a UI can show what is actually being processed. */
  onProgress?: (msg: string) => void;
  /** Called per contribution written to the KB inbox (metadata only). */
  onEmit?: (c: { id: string; denTopicId: string; domain: string }) => void;
}

export interface ConsolidateResult {
  sessionId: string;
  topicsProcessed: number;
  topicsMerged: number;
  topicsCreated: number;
  topicsSkipped: number;
  claimsSubmitted: number;
  /** Topics held in the den (log-like, `promotable: false`) and not emitted. */
  topicsHeld: number;
  /** Re-promotes skipped because the change since the last emitted version is trivial. */
  trivialSkipped: number;
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

  // Step 0: Reconcile den topics the KB has absorbed
  if (kbRoots) {
    try {
      const r = reconcileDen(den.denRoot, kbRoots, den.wolfName);
      onProgress?.(`reconciled: ${r.archived.length} archived, ${r.pending.length} pending`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onProgress?.(`reconcile skipped: ${msg}`);
    }
  }

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
      topicsHeld: 0,
      trivialSkipped: 0,
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
  let skipped = 0;
  let held = 0;
  const updatedTopics: Array<{
    id: string;
    title: string;
    summary: string;
    body: string;
    domain?: string;
    change: "create" | "merge";
  }> = [];

  const now = new Date().toISOString().replace("T", " ").slice(0, 16);

  for (const t of sessionTopics) {
    // The id names a den file and a KB key: one bad id is skipped, not fatal.
    if (!isSafeSegment(t.id)) {
      skipped++;
      onProgress?.(`  skipped topic with unsafe id ${JSON.stringify(t.id)}`);
      continue;
    }
    // Already in the KB with exactly this content: nothing to stage.
    if (kbRoots && isAbsorbed(kbRoots, den.wolfName, t.id, t.body)) {
      skipped++;
      continue;
    }
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
      domain: t.domain,
    };

    const gate = gateDenTopic(t);
    writeDenTopic(den.denRoot, { ...topic, ...gate });
    onProgress?.(`  ${change === "merge" ? "updated" : "created"}: ${t.title}`);
    if (t.body.length > TOPIC_SOFT_CAP) onProgress?.(`  topic over ${TOPIC_SOFT_CAP} chars (${t.body.length}): ${t.id} — should be split by subject`);
    if (!gate.promotable) {
      held++;
      onProgress?.(`  held back (not promotable): ${t.id} — ${gate.promotableReason}`);
      continue;
    }
    updatedTopics.push({ ...topic, change });

    if (change === "merge") merged++;
    else created++;
  }
  if (skipped > 0) onProgress?.(`  unchanged and already in the KB: ${skipped} skipped`);

  // Step 5: Distill each changed topic into KB-grade contributions and emit
  // them to the Librarian inbox. The den topic stays private working memory;
  // what reaches the KB is converted knowledge (see distill.ts). Unchanged raw
  // topics cost no LLM call; a failed distill leaves the topic pending.
  let claimsSubmitted = 0;
  let trivialSkipped = 0;

  if (!skipClaims && kbRoots && updatedTopics.length > 0) {
    const stats = await promoteTopics(updatedTopics, {
      engine,
      roots: kbRoots,
      wolf: den.wolfName,
      defaultDomain,
      session: sessionId,
      onProgress,
      onEmit: options.onEmit,
      onHold: (t, reason) => {
        const full = updatedTopics.find((x) => x.id === t.id);
        if (full) writeDenTopic(den.denRoot, { ...full, updated: now, promotable: false, promotableReason: reason });
      },
    });
    claimsSubmitted = stats.emitted;
    trivialSkipped = stats.trivialSkipped;
    held += stats.held;
    onProgress?.(`  distill: ${stats.distilled} distilled, ${stats.split} split, ${stats.held} held, ${stats.pending} pending`);
  }

  if (held > 0) onProgress?.(`  held back: ${held}`);
  if (trivialSkipped > 0) onProgress?.(`  trivial change since last emit: ${trivialSkipped} skipped`);

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
    topicsHeld: held,
    trivialSkipped,
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
