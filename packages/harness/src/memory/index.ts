export {
  consolidatePool,
  drainWorkObservations,
  type DrainWorkConfig,
  getPoolStats,
  readPool,
  promoteSessionTopics,
  durableSessionTopics,
  DURABLE_SESSION_ID,
  type ConsolidatedTopic,
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
  graduationActionsFor,
  registerGraduationActions,
  unregisterGraduationActions,
  GraduationError,
  GRADUATION_PREVIEW_TTL_MS,
  type GraduationActions,
  type GraduationObservationCount,
  type GraduationConfirmResult,
  type GraduationFailure,
  type GraduationPreviewResult,
  unregisterMemoryActions,
  type MemoryActions,
  type PromoteOutcome,
  type PromoteStart,
} from "./actions.js";
export {
  disposeMemoryEvents,
  memoryEventsFor,
  oneLine,
  type MemoryEventBus,
  type MemoryEventDraft,
  type MemoryEventListener,
} from "./events.js";

export { stripSupersededNotes, supersededNotes, type SupersededCard } from "../superseded-note.js";
