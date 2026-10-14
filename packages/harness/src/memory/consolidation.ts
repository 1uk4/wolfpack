/**
 * Pi-durable consolidation — pools observations directly to den topics.
 *
 * Mirrors Pi-CLI's consolidateSession but skips the session topics step:
 *   1. Read observations from .memory/pool/observations.jsonl
 *   2. Read existing den topics for context
 *   3. LLM consolidation (same prompt/schema as Pi-CLI)
 *   4. Write topics directly to $WOLF_DEN/memory/topics/
 *   5. Emit deltas to KB inbox (same as Pi-CLI promote)
 *   6. Archive processed observations
 */
import { readFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createEngine, CONSOLIDATE_SYSTEM } from "@wolfpack/engine";
import {
  ConsolidationResultSchema,
  writeDenTopic,
  renderDenIndex,
  ensureDenDirs,
  readDenTopics,
} from "@wolfpack/memory";
import { emitDelta } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";

/** Observation stored in pool JSONL */
export interface PoolObservation {
  timestamp: string;
  content: string;
  recordedAt: string;
}

export interface ConsolidationConfig {
  wolfDen: string;
  wolfName: string;
  /** Model for consolidation (default: claude-sonnet-4-6) */
  model?: string;
  /** Provider (default: anthropic) */
  provider?: "anthropic" | "claude-agent-sdk";
  /** KB roots for emitting deltas to Dewey (optional) */
  kbRoots?: KbRoots;
  /** Default domain hint for KB emissions (default: wolfpack) */
  defaultDomain?: string;
  /** Skip emitting to KB (default: false) */
  skipClaims?: boolean;
  /** Minimum observations to consolidate (default: 5) */
  minObservations?: number;
  /** Minimum tokens to consolidate (default: 1000) */
  minTokens?: number;
  /** Optional progress callback */
  onProgress?: (msg: string) => void;
}

export interface ConsolidationResult {
  observationsProcessed: number;
  topicsCreated: number;
  topicsMerged: number;
  topicsSkipped: number;
  claimsSubmitted: number;
}

/**
 * Read observations from the pool file.
 */
export async function readPool(wolfDen: string): Promise<PoolObservation[]> {
  const poolFile = join(wolfDen, ".memory", "pool", "observations.jsonl");
  if (!existsSync(poolFile)) return [];

  try {
    const content = await readFile(poolFile, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as PoolObservation);
  } catch {
    return [];
  }
}

/**
 * Get pool stats without reading all content.
 */
export async function getPoolStats(wolfDen: string): Promise<{ count: number; tokens: number }> {
  const observations = await readPool(wolfDen);
  const tokens = observations.reduce(
    (sum, o) => sum + Math.ceil(o.content.length / 4),
    0
  );
  return { count: observations.length, tokens };
}

/**
 * Archive the pool by moving to timestamped file.
 */
async function archivePool(wolfDen: string): Promise<void> {
  const poolDir = join(wolfDen, ".memory", "pool");
  const poolFile = join(poolDir, "observations.jsonl");
  if (!existsSync(poolFile)) return;

  const archiveDir = join(wolfDen, ".memory", "archive");
  await mkdir(archiveDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const archiveFile = join(archiveDir, `observations-${timestamp}.jsonl`);

  await rename(poolFile, archiveFile);
}

/**
 * Consolidate pool observations directly to den topics.
 * 
 * Mirrors Pi-CLI's consolidateSession but operates on the pool directly
 * instead of session topics. After writing to den, emits deltas to KB
 * (same as /wolf:promote).
 */
export async function consolidatePool(
  config: ConsolidationConfig
): Promise<ConsolidationResult> {
  const {
    wolfDen,
    wolfName,
    model = "claude-sonnet-4-6",
    provider = "anthropic",
    kbRoots,
    defaultDomain = "wolfpack",
    skipClaims = false,
    minObservations = 5,
    minTokens = 1000,
    onProgress,
  } = config;

  // Read pool
  const observations = await readPool(wolfDen);
  if (observations.length === 0) {
    onProgress?.("No observations to consolidate");
    return { observationsProcessed: 0, topicsCreated: 0, topicsMerged: 0, topicsSkipped: 0, claimsSubmitted: 0 };
  }

  // Estimate tokens
  const totalTokens = observations.reduce(
    (sum, o) => sum + Math.ceil(o.content.length / 4),
    0
  );

  // Check minimum thresholds (skip if pool too small)
  if (observations.length < minObservations && totalTokens < minTokens) {
    onProgress?.(`Pool too small (${observations.length} obs, ~${totalTokens} tokens) — skipping`);
    return { observationsProcessed: 0, topicsCreated: 0, topicsMerged: 0, topicsSkipped: 0, claimsSubmitted: 0 };
  }

  onProgress?.(`Consolidating ${observations.length} observations (~${totalTokens} tokens)`);

  // Ensure den structure exists
  ensureDenDirs(wolfDen);

  // Read existing den topics for context (pi-durable uses den directly, no session topics)
  const existingTopics = readDenTopics(wolfDen);
  const existingSection =
    existingTopics.length > 0
      ? existingTopics
          .map((t) => `### ${t.id} — ${t.title}\nSummary: ${t.summary}\n\n${t.body}`)
          .join("\n\n---\n\n")
      : "(empty — no topics yet)";

  // Build prompt (same format as Pi-CLI orchestrator)
  const obsLines = observations
    .map((o) => `${o.timestamp}  ${o.content}`)
    .join("\n");

  const prompt = `===== OBSERVATIONS TO CONSOLIDATE =====
${obsLines}
===== END OBSERVATIONS =====

===== EXISTING TOPICS =====
${existingSection}
===== END TOPICS =====

Fold the observations into topics. For each group of related observations, decide MERGE (into existing topic), CREATE (new topic), or SKIP (not worth persisting).`;

  // Create engine for consolidation
  const engine = createEngine({
    provider,
    defaultModel: model,
    steps: {
      consolidate: { model, maxTokens: 16000 },
    },
  });

  onProgress?.("Running LLM consolidation...");
  const result = await engine.call("consolidate", ConsolidationResultSchema, {
    system: CONSOLIDATE_SYSTEM,
    prompt,
  });

  // Write results directly to den (same as Pi-CLI promote step)
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  let created = 0;
  let merged = 0;
  let skipped = 0;

  const topicsDir = join(wolfDen, "memory", "topics");
  const updatedTopics: Array<{
    id: string;
    title: string;
    summary: string;
    body: string;
    change: "create" | "merge";
  }> = [];

  for (const action of result.actions) {
    if (action.action === "skip" || !action.result) {
      skipped++;
      onProgress?.(`  skipped: ${action.reasoning}`);
      continue;
    }

    const isUpdate = existsSync(join(topicsDir, `${action.result.id}.md`));
    const change: "create" | "merge" = isUpdate ? "merge" : "create";
    
    writeDenTopic(wolfDen, {
      id: action.result.id,
      title: action.result.title,
      summary: action.result.summary,
      updated: now,
      body: action.result.body,
    });

    updatedTopics.push({
      id: action.result.id,
      title: action.result.title,
      summary: action.result.summary,
      body: action.result.body,
      change,
    });

    onProgress?.(`  ${change === "merge" ? "updated" : "created"}: ${action.result.title}`);
    if (isUpdate) merged++;
    else created++;
  }

  // Emit contribution deltas to the KB (same as Pi-CLI promote)
  // Deterministic, no LLM. Hash-guarded so unchanged topics are no-ops.
  let claimsSubmitted = 0;

  if (!skipClaims && kbRoots && updatedTopics.length > 0) {
    onProgress?.("Emitting deltas to KB...");
    for (const topic of updatedTopics) {
      const emitted = emitDelta({
        roots: kbRoots,
        wolf: wolfName,
        denTopicId: topic.id,
        change: topic.change,
        domainHint: defaultDomain,
        summary: topic.summary,
        body: topic.body,
      });
      if (emitted) {
        claimsSubmitted++;
        onProgress?.(`  emitted: ${topic.id}`);
      }
    }
  }

  // Regenerate den index
  renderDenIndex(wolfDen);

  // Archive processed observations (move to .memory/archive/)
  await archivePool(wolfDen);

  onProgress?.(`Done: ${created} created, ${merged} updated, ${skipped} skipped, ${claimsSubmitted} emitted to KB`);

  return {
    observationsProcessed: observations.length,
    topicsCreated: created,
    topicsMerged: merged,
    topicsSkipped: skipped,
    claimsSubmitted,
  };
}
