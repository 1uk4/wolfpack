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

// What the observer reads of a session branch (and what it must skip)
export { serializeBranchEntries, chunkSerialized } from "./serialize-branch.js";

// Orchestrator — the main API
export {
  createOrchestrator,
  DEFAULT_CONFIG,
  type MemoryOrchestrator,
  type OrchestratorConfig,
  type BoundWork,
} from "./orchestrator.js";

// Observer
export {
  observe,
  buildObserverPrompt,
  ObserverResultSchema,
  RawObservationSchema,
  type RawObservation,
  type ObserverResult,
  type ObserveOptions,
  type ObserveResult,
  buildDomainContext,
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
  renderIndex,
  listSessionIds,
  type TopicFile,
} from "./session/index.js";

// Den (wolf-level memory)
export {
  readDenTopics,
  readArchivedDenTopics,
  readResendTopics,
  type ArchivedDenTopic,
  readDenJourney,
  writeDenTopic,
  gateDenTopic,
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

// Session-consolidation prompt (durable runtime consolidates its pool into session topics with the same prompt)
export { SESSION_CONSOLIDATION_USER_PROMPT } from "./config/prompts/consolidations.js";
export { fillPromptTemplate } from "./config/prompts/template.js";

// Task prompts
export {
  NEW_WORK_PROMPT,
  newWorkPrompt,
  GRILLING_PROTOCOL,
  TO_SPEC_PROTOCOL,
  TO_TICKETS_PROTOCOL,
} from "./config/prompts/tasks.js";

// Prompt context — shared rendering for system prompt injection
export { renderDenContext, renderKbAccess } from "./prompt-context.js";

// Den reconcile — archive den topics the KB has absorbed (receipt-driven)
export {
  reconcileDen,
  isAbsorbed,
  denTopicStates,
  describeStatus,
  denArchiveDir,
  type DenTopicStatus,
  type DenTopicState,
  type ReconcileResult,
} from "./den-reconcile.js";

// Distill — convert den topics into KB-grade contributions at promote
export {
  promoteTopics,
  distillTopic,
  readDistillRecord,
  DistillOutputSchema,
  existingFor,
  type PromoteTopic,
  type PromoteOptions,
  type PromoteStats,
  type DistillInput,
  type DistillResult,
  type DistillRecord,
  type DistilledContribution,
} from "./distill.js";
export { TOPIC_SOFT_CAP } from "./consolidate.js";

// Work Record — curated per-item knowledge kept in the work item itself
export {
  consolidateWorkRecords,
  HttpWorkRecordStore,
  extractRecord,
  withoutRecord,
  replaceRecordSection,
  renderRecord,
  WorkRecordSchema,
  RECORD_HEADING,
  RECORD_CAP,
  DOCUMENT_CAP,
  renderWorkingDocument,
  renderFeatureRecord,
  type WorkRecord,
  type WorkRecordStore,
  type WorkRecordItem,
  type WorkObservation,
  type WorkRecordOutcome,
  type ConsolidateWorkOptions,
} from "./work-record.js";
export { scanSecrets, type SecretScan } from "./work/secrets.js";

// Resend (Dewey rebuild from scratch)
export { readResendSet, resendDenTopics, type ResendSet } from "./resend.js";

// Per-conversation binding files (memory extension + wolfd)
export { bindingFile, readBindingFile, writeBindingFile, findHolder, type StoredBinding } from "./binding-file.js";
