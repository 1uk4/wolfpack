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

// Graduation
export {
  canGraduate,
  readyToGraduate,
  graduationEntryId,
  archiveSet,
  featureDossier,
  graduationFile,
  graduationFiles,
  hubDossier,
  hubOf,
  type GraduationFile,
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
