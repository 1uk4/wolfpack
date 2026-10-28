/**
 * @wolfpack/memory/work — Work item lifecycle integration
 * 
 * Unified system for:
 * - Stage-aware context injection
 * - Stage transition detection + confirmation prompts
 * - File observation during work sessions
 * - Task completion summarization
 * - Feature/initiative graduation to KB
 */

// Stage detection and transitions
export {
  detectTransition,
  extractTransitionContext,
  type TransitionSignal,
  type BreakdownSuggestion,
} from "./stage-detection.js";

// Ship policy (confirm vs. auto for agent loops)
export { resolveShipPolicy, shouldConfirmShip, type ShipPolicy } from "./ship-policy.js";

// /task workspace browser (pure state + key reducer)
export {
  initialState,
  reduce,
  leftRows,
  rightRows,
  rightTree,
  dependencyTree,
  relatedTo,
  firstTask,
  progress,
  isBlocked,
  type SelectorState,
  type SelectorKey,
  type SelectorEffect,
  type LeftRow,
  type TaskRow,
  type Pane,
  isIdeasFolder,
  ideaCount,
} from "./selector.js";

// Workspace context for the agent
export { workspaceHeader } from "./workspace.js";

// File observation
export {
  startFileTracking,
  stopFileTracking,
  recordFileChange,
  getFileSession,
  summarizeFileChanges,
  groupFilesByDirectory,
  detectPatterns,
  type FileChange,
  type WorkFileSession,
  type WorkPattern,
} from "./file-observation.js";

// Rollup (child → parent feature body)
export {
  extractDistilled,
  upsertRollupBlock,
  recomputeTotals,
  parseKeyedValue,
  sumKeys,
  rollupToParent,
  hasRollupZone,
  stripRollupMarkers,
  totalsSummary,
  ensureOutcomesZone,
  outcomesText,
  totalsText,
  totalsValues,
  withoutRollup,
  OUTCOMES_HEADING,
  type ChildMeta,
  type ParsedValue,
  type RollupClient,
} from "./rollup.js";

// Graduation
export {
  canGraduate,
  readyToGraduate,
  readinessOf,
  archiveSet,
  initiativeOf,
  buildGraduationInput,
  previewGraduation,
  renderGraduationPreview,
  confirmGraduation,
  drainScope,
  type DrainWork,
  type GraduationInput,
  type GraduationClient,
  type GraduationPreview,
  type PreviewContribution,
  type ConfirmedGraduation,
} from "./graduate.js";

// Session tracking + summarization (prompt text lives in config/prompts/tasks.ts)
export {
  getStageContext,
  onWorkBound,
  addWorkObservation,
  addWorkNote,
  addStageChange,
  getWorkSession,
  summarizeTask,
  embedTaskInParent,
  areAllChildrenComplete,
  processWorkEvent,
  type WorkSession,
  type SummarizeTaskInput,
  type SummarizeTaskResult,
  type WorkEventContext,
} from "../work-memory.js";

// A feature follows its tasks into build
export { syncFeatureStage, BEFORE_BUILD, type StageSyncClient } from "./stage-sync.js";

// Binding: rules text, unbound notice, auto-bind, heads-up
export {
  UNBOUND_CONTEXT,
  BINDING_RULES,
  completeLine,
  unboundCompleteNotice,
  shouldBindOnCreate,
  notBoundReason,
  bindingLabel,
  createSerial,
  readyBoundContext,
  readyBoundReply,
  headsUp,
  withHeadsUp,
  recordFeatureId,
  type AutoBindInput,
} from "./binding.js";
