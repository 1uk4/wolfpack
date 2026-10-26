export {
  consolidatePool,
  getPoolStats,
  promoteSessionTopics,
  durableSessionTopics,
  DURABLE_SESSION_ID,
  type ConsolidationConfig,
  type ConsolidationResult,
  type PromoteSessionConfig,
  type SessionTopicsLocation,
} from "./consolidation.js";

// Re-export shared prompt context from @wolfpack/memory
export { renderDenContext, renderKbAccess } from "@wolfpack/memory";
export {
  memoryActionsFor,
  registerMemoryActions,
  unregisterMemoryActions,
  type MemoryActions,
  type PromoteOutcome,
  type PromoteStart,
} from "./actions.js";
