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
  BREAKDOWN_SUGGESTION_SYSTEM,
  type TransitionSignal,
  type BreakdownSuggestion,
} from "./stage-detection.js";

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
  needsParentFirst,
  buildContribution,
  graduateWorkItem,
  processGraduationQueue,
  type GraduationContribution,
  type GraduationResult,
  type GraduationContext,
} from "./graduate.js";

// Re-export from work-memory (session tracking, summarization)
export {
  STAGE_CONTEXT,
  getStageContext,
  onWorkBound,
  onWorkUnbound,
  addWorkObservation,
  addWorkNote,
  addStageChange,
  getWorkSession,
  summarizeTask,
  embedTaskInParent,
  areAllChildrenComplete,
  isComplete,
  processWorkEvent,
  TASK_SUMMARY_SYSTEM,
  type WorkSession,
  type SummarizeTaskInput,
  type SummarizeTaskResult,
  type WorkEventContext,
} from "../work-memory.js";
