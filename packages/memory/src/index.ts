/**
 * @wolfpack/memory — the complete memory system.
 *
 * Agent-agnostic. Provides:
 *   - Observer: extract observations from conversation
 *   - Ledger: append-only observation buffer with fold/tombstone
 *   - Session memory: per-session topic files and journey
 *   - Den: wolf-level persistent memory
 *   - Consolidation: session → den promotion
 *   - Auto-claims: den → Librarian submission
 *   - Orchestrator: coordinates the full lifecycle
 *   - Runtime interface: what any agent platform implements
 */

// Runtime interface — implement this for your agent
export type {
  AgentRuntime,
  ConversationChunk,
  LedgerEntry,
  MemoryEvent,
  MemoryEventHandler,
} from "./runtime.js";

// Orchestrator — the main API
export {
  createOrchestrator,
  DEFAULT_CONFIG,
  type MemoryOrchestrator,
  type OrchestratorConfig,
} from "./orchestrator.js";

// Observer
export {
  observe,
  observeParallel,
  buildObserverPrompt,
  ObserverResultSchema,
  RawObservationSchema,
  type RawObservation,
  type ObserverResult,
  type ObserveOptions,
  type ObserveResult,
} from "./observer/index.js";

// Ledger
export {
  foldLedger,
  poolTokens,
  selectPromotionOverflow,
  sortObservations,
  type Observation,
  type ObservationsRecorded,
  type ObservationsDropped,
  type CostRecord,
  type LedgerEvent,
  type FoldedLedger,
} from "./ledger/index.js";

// Session memory
export {
  sessionMemoryRoot,
  readTopics,
  readJourney,
  writeTopic,
  writeJourney,
  renderIndex,
  listSessionIds,
  type TopicFile,
} from "./session/index.js";

// Den (wolf-level memory)
export {
  readDenTopics,
  readDenJourney,
  writeDenTopic,
  writeDenJourney,
  getConsolidatedSessions,
  markSessionConsolidated,
  ensureDenDirs,
  type DenTopic,
  type DenConfig,
} from "./den.js";

// Consolidation (session → den)
export {
  consolidateSession,
  type ConsolidateOptions,
  type ConsolidateResult,
} from "./consolidate.js";

// Den index
export { renderDenIndex } from "./den-index.js";

// Consolidation schemas
export {
  ConsolidationResultSchema,
  type ConsolidationResult,
  type TopicAction,
} from "./schemas.js";

// Crawl — deterministic corpus ingestion (reproduce the pipeline across time).
export * from "./crawl/index.js";

// Work Memory — unified work item lifecycle
export * from "./work/index.js";
