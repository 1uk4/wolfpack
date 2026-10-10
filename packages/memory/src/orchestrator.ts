/**
 * Memory orchestrator — the agent-agnostic coordinator.
 *
 * This is the main entry point that any agent runtime calls.
 * It owns the full lifecycle:
 *   1. Observe new conversation chunks → buffer observations
 *   2. Consolidate overflow → session topic files
 *   3. On session end → promote to den (wolf memory)
 *   4. Auto-claim → submit to Librarian
 *
 * The orchestrator is stateful per-session but never imports any
 * agent-specific code. The runtime feeds it events and content.
 */
import type { Engine } from "@wolfpack/engine";
import { CONSOLIDATE_SYSTEM } from "@wolfpack/engine";
import { SESSION_CONSOLIDATION_USER_PROMPT } from "./config/prompts/consolidations.js";
import { fillPromptTemplate } from "./config/prompts/template.js";
import type { AgentRuntime, ConversationChunk } from "./runtime.js";
import { observe } from "./observer/observe.js";
import { ConsolidationResultSchema } from "./schemas.js";
import type { Observation, LedgerEvent } from "./ledger/types.js";
import { foldLedger, poolTokens, selectPromotionOverflow } from "./ledger/fold.js";
import {
  sessionMemoryRoot,
  readTopics,
  readJourney,
  writeTopic,
  renderIndex,
} from "./session/memory.js";
import { consolidateSession, type ConsolidateResult } from "./consolidate.js";
import type { DenConfig } from "./den.js";
import type { KbRoots } from "@wolfpack/kb/shared";

export interface OrchestratorConfig {
  /** Tokens per observer chunk */
  chunkTokens: number;
  /** Pool size that triggers consolidation */
  consolidateAtPoolTokens: number;
  /** Target pool size after consolidation */
  poolTargetTokens: number;
  /** Max parallel observers */
  observerConcurrency: number;
  /** KB roots; when set, promotion emits contribution deltas to the librarian. */
  kbRoots?: KbRoots;
  /** Default domain hint for emitted deltas (default: "wolfpack"). */
  defaultDomain?: string;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  chunkTokens: 5000,
  consolidateAtPoolTokens: 20000,
  poolTargetTokens: 10000,
  observerConcurrency: 4,
};

export interface MemoryOrchestrator {
  /**
   * Process new conversation content. Call this when the runtime has
   * new chunks to observe. Fires observers for each chunk, commits
   * results to the ledger, and triggers consolidation if needed.
   */
  processChunks(chunks: ConversationChunk[]): Promise<void>;

  /**
   * Force consolidation now (ignores threshold).
   */
  consolidateNow(): Promise<void>;

  /**
   * Promote session memory to wolf den. Call on session end.
   * Resolves with the consolidation result (counts + per-topic details).
   */
  promoteToWolfMemory(denConfig: DenConfig): Promise<ConsolidateResult>;

  /**
   * Get the current observation buffer for context injection.
   */
  getActiveObservations(): Observation[];

  /**
   * Get the session memory root path.
   */
  getMemoryRoot(): string;
}

/**
 * Create an orchestrator for a session.
 */
export function createOrchestrator(
  engine: Engine,
  runtime: AgentRuntime,
  config: Partial<OrchestratorConfig> = {}
): MemoryOrchestrator {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const memRoot = sessionMemoryRoot(runtime.cwd, runtime.sessionId);

  // In-memory ledger events (also persisted via runtime)
  // The runtime stores generic LedgerEntry; we extract the typed data.
  let ledgerEvents: LedgerEvent[] = runtime
    .readLedger()
    .map((entry) => entry.data as LedgerEvent)
    .filter((e): e is LedgerEvent => e != null && typeof e === "object" && "type" in e);

  function appendEvent(event: LedgerEvent): void {
    ledgerEvents.push(event);
    runtime.appendLedger({
      type: event.type,
      timestamp: new Date().toISOString(),
      data: event,
    });
  }

  function estimateTokens(text: string): number {
    // Rough estimate: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Assign unique timestamps to observations.
   * Mirrors OM's assignObservationTimestamps: normalizes minute-resolution
   * model timestamps ("YYYY-MM-DD HH:MM") to second-resolution ids
   * ("YYYY-MM-DDTHH:MM:00") and appends ".01", ".02" for collisions.
   */
  function assignUniqueTimestamps(
    observations: Array<{ timestamp: string; content: string }>
  ): Array<{ timestamp: string; content: string }> {
    const used = new Set<string>();
    // Seed with already-known timestamps from the ledger
    const folded = foldLedger(ledgerEvents);
    for (const ts of folded.byTimestamp.keys()) used.add(ts);

    const pad = (n: number) => n.toString().padStart(2, "0");

    // Normalize "YYYY-MM-DD HH:MM" → "YYYY-MM-DDTHH:MM:00"
    function toBase(modelTs: string): string {
      const m = modelTs.trim().match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
      if (m) return `${m[1]}T${m[2]}:00`;
      // Already has seconds or is ISO — use as-is
      return modelTs.replace(" ", "T");
    }

    return observations.map((o) => {
      const base = toBase(o.timestamp);
      let ts = base;
      if (used.has(ts)) {
        let suffix = 1;
        do {
          ts = `${base}.${pad(suffix)}`;
          suffix++;
        } while (used.has(ts));
      }
      used.add(ts);
      return { ...o, timestamp: ts };
    });
  }

  async function processChunks(chunks: ConversationChunk[]): Promise<void> {
    // Observe each chunk (could parallelize later)
    for (const chunk of chunks) {
      const result = await observe({ engine, chunkText: chunk.text });

      if (result.observations.length > 0) {
        const uniqueObs = assignUniqueTimestamps(result.observations);
        const observations: Observation[] = uniqueObs.map((o) => ({
          timestamp: o.timestamp,
          content: o.content,
          tokenCount: estimateTokens(o.content),
        }));

        appendEvent({
          type: "observations_recorded",
          observations,
          coversUpToId: chunk.id,
        });

        runtime.notify?.(
          `memory: +${observations.length} observations`,
          "info"
        );
      }
    }

    // Check if consolidation is needed
    const folded = foldLedger(ledgerEvents);
    if (poolTokens(folded.activeObservations) >= cfg.consolidateAtPoolTokens) {
      await runConsolidation();
    }
  }

  async function runConsolidation(forceAll: boolean = false): Promise<void> {
    const folded = foldLedger(ledgerEvents);

    let promote: typeof folded.activeObservations;
    if (forceAll) {
      // Force mode: consolidate everything
      promote = [...folded.activeObservations];
    } else {
      // Normal mode: only promote overflow above target
      ({ promote } = selectPromotionOverflow(
        folded.activeObservations,
        cfg.poolTargetTokens
      ));
    }

    if (promote.length === 0) return;

    runtime.notify?.(
      `memory: consolidating ${promote.length} observations`,
      "info"
    );

    // Build prompt from observations
    const obsLines = promote
      .map((o) => `${o.timestamp}  ${o.content}`)
      .join("\n");

    // Read existing session topics for context
    const existingTopics = readTopics(memRoot);
    const journey = readJourney(memRoot);

    const existingSection =
      existingTopics.length > 0
        ? existingTopics
            .map((t) => `### ${t.id} — ${t.title}\nSummary: ${t.summary}\n\n${t.body}`)
            .join("\n\n---\n\n")
        : "(empty — no session memory yet)";

    const prompt = fillPromptTemplate(SESSION_CONSOLIDATION_USER_PROMPT, {
      obsLines,
      existingSection,
      journeyBlock: journey
        ? `===== CURRENT JOURNEY =====\n${journey}\n===== END JOURNEY =====\n`
        : "",
    });

    const result = await engine.call("consolidate", ConsolidationResultSchema, {
      system: CONSOLIDATE_SYSTEM,
      prompt,
    });

    const now = new Date().toISOString().replace("T", " ").slice(0, 16);

    // Write results
    for (const action of result.actions) {
      if (action.action === "skip" || !action.result) continue;

      writeTopic(memRoot, {
        id: action.result.id,
        title: action.result.title,
        summary: action.result.summary,
        updated: now,
        body: action.result.body,
      });
    }

    // Tombstone promoted observations
    const timestamps = promote.map((o) => o.timestamp);
    if (timestamps.length > 0) {
      appendEvent({
        type: "observations_dropped",
        observationTimestamps: timestamps,
        coversUpToId: folded.latestCoverageId ?? "",
      });
    }

    // Regenerate index
    renderIndex(memRoot);

    runtime.notify?.(
      `memory: consolidated ${promote.length} observations into session topics`,
      "info"
    );
  }

  async function consolidateNow(): Promise<void> {
    // Force mode: promote ALL observations, not just overflow
    await runConsolidation(true);
  }

  async function promoteToWolfMemory(
    denConfig: DenConfig
  ): Promise<ConsolidateResult> {
    runtime.notify?.("memory: promoting session to wolf memory", "info");

    const result = await consolidateSession({
      engine,
      den: denConfig,
      memoryRoot: sessionMemoryRoot(runtime.cwd, ""),
      sessionId: runtime.sessionId,
      kbRoots: cfg.kbRoots,
      defaultDomain: cfg.defaultDomain,
      skipClaims: false,
      onProgress: (msg) => runtime.notify?.(`memory: ${msg}`, "info"),
    });

    runtime.notify?.("memory: session promoted to wolf memory", "info");
    return result;
  }

  function getActiveObservations(): Observation[] {
    return foldLedger(ledgerEvents).activeObservations;
  }

  function getMemoryRoot(): string {
    return memRoot;
  }

  return {
    processChunks,
    consolidateNow,
    promoteToWolfMemory,
    getActiveObservations,
    getMemoryRoot,
  };
}
