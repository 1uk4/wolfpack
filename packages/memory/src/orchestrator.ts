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
import { buildDomainContext } from "./observer/domain-context.js";
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
import { consolidateWorkRecords, type WorkRecordStore } from "./work-record.js";

/**
 * The event-bus channel on which other extensions hand work observations to
 * the memory extension (see MemoryOrchestrator.recordWorkObservations). The
 * subagents extension carries its own copy of this string; a test keeps them equal.
 */
export const WORK_OBSERVATIONS_CHANNEL = "wolfpack:work-observations";

/** Payload on WORK_OBSERVATIONS_CHANNEL. */
export interface WorkObservationsMessage {
  /** The work item the material is about. */
  work: string;
  /** Its parent feature, when it has one (consolidation decides if that is a real one). */
  feature?: string;
  /** `subagent:<name>` */
  source: string;
  contents: string[];
}

/** The work item a session is bound to right now. */
export interface BoundWork {
  taskId: string;
  featureId?: string | null;
}

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
  /** All domains the wolf subscribes to. Enables per-observation domain classification. */
  domains?: string[];
  /** Path to KB base directory (for building domain context). */
  kbBasePath?: string;
  /**
   * The task the session is bound to, read at observation time. While one is
   * bound, observations are stamped `work: <task id>`; they feed that item's
   * Record instead of den topics.
   */
  getBoundWork?: () => BoundWork | null | undefined;
  /** Where Records are written (the Work API). Absent: tagged observations fall back to the den. */
  workRecordStore?: WorkRecordStore;
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
   * Add observations from outside the observer (a subagent's report) to the
   * pool, tagged with the work item and source. Same ledger event as the
   * observer's, so Record consolidation picks them up unchanged. Returns how
   * many were recorded.
   */
  recordWorkObservations(msg: WorkObservationsMessage): number;

  /**
   * Get the current observation buffer for context injection.
   */
  getActiveObservations(): Observation[];

  /**
   * Change the domain stamped on observations the observer leaves untagged.
   * Applies to observations recorded from now on; already-pooled ones keep
   * the domain they were stamped with.
   */
  setDefaultDomain(domain: string): void;

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

  // Build domain context once at startup for per-observation classification
  const domainContext = cfg.domains && cfg.domains.length > 1
    ? buildDomainContext(cfg.domains, cfg.kbBasePath ?? cfg.kbRoots?.kbBase)
    : "";

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
  function assignUniqueTimestamps<T extends { timestamp: string; content: string }>(
    observations: T[]
  ): T[] {
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
      const result = await observe({ engine, chunkText: chunk.text, domainContext: domainContext || undefined });

      if (result.observations.length > 0) {
        const uniqueObs = assignUniqueTimestamps(result.observations);
        // Stamp untagged observations with the domain current at observe
        // time, so a later domain switch can't reroute them at promote.
        let bound: BoundWork | null | undefined;
        try { bound = cfg.getBoundWork?.(); } catch { bound = undefined; }
        const observations: Observation[] = uniqueObs.map((o) => ({
          timestamp: o.timestamp,
          content: o.content,
          tokenCount: estimateTokens(o.content),
          domain: o.domain || cfg.defaultDomain,
          ...(bound?.taskId ? { work: bound.taskId, ...(bound.featureId ? { feature: bound.featureId } : {}) } : {}),
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

  // Consolidation and promotion mutate the same session topics on disk, and
  // each snapshots the pool when it starts. Run them one at a time so a
  // background /wolf:promote, the auto-consolidation trigger and a shutdown
  // save can't consolidate the same observations twice or interleave topic
  // writes. Each run re-folds the ledger when it gets the lock, and tombstones
  // only the observations it consolidated, so observations recorded meanwhile
  // stay in the pool.
  let memoryOpTail: Promise<unknown> = Promise.resolve();
  function serialized<T>(op: () => Promise<T>): Promise<T> {
    const run = memoryOpTail.then(op, op);
    memoryOpTail = run.catch(() => {});
    return run;
  }

  function runConsolidation(forceAll: boolean = false): Promise<void> {
    return serialized(() => consolidatePool(forceAll));
  }

  async function consolidatePool(forceAll: boolean): Promise<void> {
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

    // Observations tagged with a work item feed that item's Record, not the
    // den. Their outcome decides what the den pass sees: written → consumed;
    // fallback (item archived/deleted, no Work API) → den like any other;
    // pending (infra error) → left in the pool for the next run.
    const consumedWork = new Set<string>();
    const heldWork = new Set<string>();
    const tagged = promote.filter((o) => o.work);
    if (tagged.length > 0) {
      runtime.notify?.(`memory: updating Records from ${tagged.length} work observation(s)`, "info");
      const outcomes = await consolidateWorkRecords({
        engine,
        store: cfg.workRecordStore,
        observations: tagged.map((o) => ({ id: o.timestamp, content: o.content, work: o.work!, ...(o.feature ? { feature: o.feature } : {}) })),
        onProgress: (m) => runtime.notify?.(`memory: ${m.trim()}`, "info"),
      });
      const status = new Map(outcomes.flatMap((o) => o.ids.map((id) => [id, o.status] as const)));
      for (const o of tagged) {
        const st = status.get(o.timestamp);
        if (st === "written") consumedWork.add(o.timestamp);
        else if (st === "pending") heldWork.add(o.timestamp);
      }
      if (consumedWork.size > 0) {
        appendEvent({
          type: "observations_dropped",
          observationTimestamps: [...consumedWork],
          coversUpToId: folded.latestCoverageId ?? "",
        });
      }
    }
    // Fallback observations are consolidated as plain den observations.
    promote = promote.filter((o) => !consumedWork.has(o.timestamp) && !heldWork.has(o.timestamp));
    if (promote.length === 0) return;

    runtime.notify?.(
      `memory: consolidating ${promote.length} observations`,
      "info"
    );

    // Build prompt from observations
    const obsLines = promote
      .map((o) => {
        const domainTag = o.domain ? ` [${o.domain}]` : "";
        return `${o.timestamp}${domainTag}  ${o.content}`;
      })
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

    let system = CONSOLIDATE_SYSTEM;
    if (domainContext) {
      system += `\n\nObservations carry domain tags [domain]. When creating or merging topics, set the domain field to match the dominant domain of the observations in that group. NEVER merge observations from different domains into the same topic.\n\n${domainContext}`;
    }

    const result = await engine.call("consolidate", ConsolidationResultSchema, {
      system,
      prompt,
    });

    const now = new Date().toISOString().replace("T", " ").slice(0, 16);

    // If the consolidator drops a topic's domain, fall back to the batch's
    // domain when the batch has exactly one; otherwise leave it unset.
    const batchDomains = new Set(promote.map((o) => o.domain).filter(Boolean));
    const soleDomain = batchDomains.size === 1 ? [...batchDomains][0] : undefined;

    // Write results
    for (const action of result.actions) {
      if (action.action === "skip" || !action.result) continue;

      writeTopic(memRoot, {
        id: action.result.id,
        title: action.result.title,
        summary: action.result.summary,
        updated: now,
        body: action.result.body,
        domain: action.result.domain || soleDomain,
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

  function promoteToWolfMemory(denConfig: DenConfig): Promise<ConsolidateResult> {
    return serialized(() => promoteSession(denConfig));
  }

  async function promoteSession(denConfig: DenConfig): Promise<ConsolidateResult> {
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

  function recordWorkObservations(msg: WorkObservationsMessage): number {
    const contents = msg.contents.map((c) => c.trim()).filter(Boolean);
    if (!msg.work || contents.length === 0) return 0;
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const observations: Observation[] = assignUniqueTimestamps(contents.map((content) => ({ timestamp: stamp, content }))).map((o) => ({
      timestamp: o.timestamp,
      content: o.content,
      tokenCount: estimateTokens(o.content),
      domain: cfg.defaultDomain,
      work: msg.work,
      ...(msg.feature ? { feature: msg.feature } : {}),
      source: msg.source,
    }));
    // The watermark stays where the observer left it.
    appendEvent({ type: "observations_recorded", observations, coversUpToId: foldLedger(ledgerEvents).latestCoverageId ?? "" });
    runtime.notify?.(`memory: +${observations.length} from ${msg.source}`, "info");
    return observations.length;
  }

  function getActiveObservations(): Observation[] {
    return foldLedger(ledgerEvents).activeObservations;
  }

  function getMemoryRoot(): string {
    return memRoot;
  }

  function setDefaultDomain(domain: string): void {
    cfg.defaultDomain = domain;
  }

  return {
    processChunks,
    consolidateNow,
    promoteToWolfMemory,
    recordWorkObservations,
    getActiveObservations,
    getMemoryRoot,
    setDefaultDomain,
  };
}
