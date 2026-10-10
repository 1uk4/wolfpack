/**
 * work-memory.ts — Work item lifecycle integration with memory system
 * 
 * Listens for work events and integrates with the memory pipeline:
 * - Track active work sessions (wolf bound to task)
 * - Collect context during work (observations, notes, stage changes)
 * - Summarize on completion (using consolidate step)
 * - Embed summary in parent feature
 * - Trigger graduation when parent completes
 */
import type { Engine } from "@wolfpack/engine";
import type { WorkItem, WorkId, WorkEvent, WolfId } from "@wolfpack/kb/client";
import {
  ACTIVE_WORK_CONTEXT_HEADER,
  SUCCESS_CRITERIA_LINE,
  STAGE_CONTEXT,
  TASK_SUMMARY_SYSTEM,
} from "./config/prompts/tasks.js";
import { fillPromptTemplate } from "./config/prompts/template.js";

// ════════════════════════════════════════════════════════════════════════════
// 1 · WORK SESSION TRACKING
// ════════════════════════════════════════════════════════════════════════════

export interface WorkSession {
  workId: WorkId;
  wolf: WolfId;
  boundAt: string;
  /** Observations collected while working on this task */
  observations: Array<{ at: string; content: string }>;
  /** Notes added via task_note */
  notes: Array<{ at: string; text: string }>;
  /** Stage transitions during this session */
  stageChanges: Array<{ at: string; to: string }>;
}

/** Active work sessions by work item id */
const activeSessions = new Map<WorkId, WorkSession>();

// ════════════════════════════════════════════════════════════════════════════
// 2 · STAGE-AWARE CONTEXT INJECTION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get the stage context for a work item to inject into prompts.
 * Stage text lives in config/prompts/tasks.ts (STAGE_CONTEXT).
 */
export function getStageContext(item: WorkItem): string {
  const context = STAGE_CONTEXT[item.stage];
  if (!context) return "";

  const header = fillPromptTemplate(ACTIVE_WORK_CONTEXT_HEADER, {
    title: item.title,
    kind: item.kind,
    stage: item.stage,
  });
  const criteria = item.successCriteria
    ? fillPromptTemplate(SUCCESS_CRITERIA_LINE, { successCriteria: item.successCriteria })
    : "";

  return header + criteria + context;
}

// ════════════════════════════════════════════════════════════════════════════
// 3 · EVENT HANDLERS
// ════════════════════════════════════════════════════════════════════════════

/**
 * Handle wolf binding to a work item — start tracking session
 */
export function onWorkBound(workId: WorkId, wolf: WolfId, at: string): void {
  activeSessions.set(workId, {
    workId,
    wolf,
    boundAt: at,
    observations: [],
    notes: [],
    stageChanges: [],
  });
}

/**
 * Handle wolf unbinding from a work item — end session but keep data
 * (data is cleared after summarization on completion)
 */
export function onWorkUnbound(workId: WorkId): void {
  // Keep session data — it will be used for summarization if task completes
}

/**
 * Add an observation to the active work session
 * (called by memory observer when wolf is bound to a task)
 */
export function addWorkObservation(workId: WorkId, at: string, content: string): void {
  const session = activeSessions.get(workId);
  if (session) {
    session.observations.push({ at, content });
  }
}

/**
 * Add a note to the active work session
 * (called when task_note is used)
 */
export function addWorkNote(workId: WorkId, at: string, text: string): void {
  const session = activeSessions.get(workId);
  if (session) {
    session.notes.push({ at, text });
  }
}

/**
 * Record a stage change in the active work session
 */
export function addStageChange(workId: WorkId, at: string, to: string): void {
  const session = activeSessions.get(workId);
  if (session) {
    session.stageChanges.push({ at, to });
  }
}

/**
 * Get the active session for a work item (for inspection)
 */
export function getWorkSession(workId: WorkId): WorkSession | undefined {
  return activeSessions.get(workId);
}

// ════════════════════════════════════════════════════════════════════════════
// 4 · TASK COMPLETION SUMMARIZATION
// ════════════════════════════════════════════════════════════════════════════

import { z } from "zod";

const TaskSummaryResult = z.object({
  summary: z.string().max(140),
  implementation: z.string(),
});

export interface SummarizeTaskInput {
  task: WorkItem;
  taskBody: string;
  session: WorkSession | null;
}

export interface SummarizeTaskResult {
  summary: string;
  implementation: string;
}

/**
 * Summarize a completed task using the memory consolidation engine
 */
export async function summarizeTask(
  engine: Engine,
  input: SummarizeTaskInput
): Promise<SummarizeTaskResult> {
  const { task, taskBody, session } = input;

  // Build context from session
  const observationText = session?.observations.length
    ? `\n\nOBSERVATIONS DURING WORK:\n${session.observations.map(o => `- ${o.content}`).join("\n")}`
    : "";

  const notesText = session?.notes.length
    ? `\n\nNOTES ADDED:\n${session.notes.map(n => `- ${n.text}`).join("\n")}`
    : "";

  const durationText = session
    ? `\n\nDURATION: ${calculateDuration(session.boundAt, new Date().toISOString())}`
    : "";

  const prompt = [
    `TASK: ${task.title}`,
    task.successCriteria ? `SUCCESS CRITERIA: ${task.successCriteria}` : "",
    task.area ? `AREA: ${task.area}` : "",
    "",
    "TASK PLAN/NOTES:",
    taskBody || "(no notes)",
    observationText,
    notesText,
    durationText,
  ].filter(Boolean).join("\n");

  const result = await engine.call("consolidate", TaskSummaryResult, {
    system: TASK_SUMMARY_SYSTEM,
    prompt,
  });

  // Clear session data after summarization
  activeSessions.delete(task.id);

  return result;
}

function calculateDuration(start: string, end: string): string {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffMins = Math.round(diffMs / 60000);
  
  if (diffMins < 60) return `${diffMins} minutes`;
  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  return mins > 0 ? `${hours}h ${mins}m` : `${hours} hours`;
}

// ════════════════════════════════════════════════════════════════════════════
// 5 · PARENT EMBEDDING
// ════════════════════════════════════════════════════════════════════════════

/**
 * Embed a task summary into its parent feature's body
 * Appends under ## Implementation Log section
 */
export function embedTaskInParent(
  parentBody: string,
  taskTitle: string,
  summary: SummarizeTaskResult,
  completedAt: string
): string {
  const logSection = "## Implementation Log";
  const entry = `
### ${taskTitle}
_Completed ${completedAt}_

${summary.implementation}
`;

  if (parentBody.includes(logSection)) {
    // Append to existing section
    const parts = parentBody.split(logSection);
    return parts[0] + logSection + parts[1] + entry;
  } else {
    // Create new section at end
    return parentBody.trim() + "\n\n" + logSection + "\n" + entry;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 6 · COMPLETION DETECTION
// ════════════════════════════════════════════════════════════════════════════

const COMPLETE_STAGES = ["shipped", "live", "archived"];

/**
 * Check if all children of a work item are complete
 */
export function areAllChildrenComplete(children: WorkItem[]): boolean {
  return children.length > 0 && children.every(c => COMPLETE_STAGES.includes(c.stage));
}

/**
 * Check if a work item is complete
 */
export function isComplete(item: WorkItem): boolean {
  return COMPLETE_STAGES.includes(item.stage);
}

// ════════════════════════════════════════════════════════════════════════════
// 7 · WORK EVENT PROCESSOR
// ════════════════════════════════════════════════════════════════════════════

export interface WorkEventContext {
  engine: Engine;
  getItem: (id: WorkId) => WorkItem | undefined;
  getBody: (id: WorkId) => string;
  setBody: (id: WorkId, body: string) => void;
  getChildren: (parentId: WorkId) => WorkItem[];
  setSummary: (id: WorkId, summary: string) => void;
  emitEvent: (event: WorkEvent) => void;
}

/**
 * Process a work event and trigger appropriate actions
 */
export async function processWorkEvent(
  event: WorkEvent,
  ctx: WorkEventContext
): Promise<{ action: string; details?: string } | null> {
  switch (event.type) {
    case "work.bound":
      onWorkBound(event.id, event.wolf, event.at);
      return { action: "session_started", details: `Wolf ${event.wolf} bound to ${event.id}` };

    case "work.unbound":
      onWorkUnbound(event.id);
      return { action: "session_ended" };

    case "work.noted":
      addWorkNote(event.id, event.at, event.text);
      return null; // No external action needed

    case "work.staged":
      addStageChange(event.id, event.at, event.to);
      
      // Check for completion (shipped stage)
      if (event.to === "shipped") {
        const task = ctx.getItem(event.id);
        if (!task) return null;

        // Only summarize tasks (not features/initiatives)
        if (task.kind === "task") {
          const session = getWorkSession(event.id);
          const taskBody = ctx.getBody(event.id);
          
          // Summarize the task
          const summary = await summarizeTask(ctx.engine, {
            task,
            taskBody,
            session: session || null,
          });

          // Update task summary
          ctx.setSummary(event.id, summary.summary);
          ctx.emitEvent({
            type: "work.summarized",
            id: event.id,
            at: new Date().toISOString(),
            summary: summary.summary,
          });

          // Embed in parent if exists
          if (task.partOf) {
            const parent = ctx.getItem(task.partOf as WorkId);
            if (parent) {
              const parentBody = ctx.getBody(task.partOf as WorkId);
              const updatedBody = embedTaskInParent(
                parentBody,
                task.title,
                summary,
                new Date().toISOString().split("T")[0]
              );
              ctx.setBody(task.partOf as WorkId, updatedBody);

              // Check if parent is now complete
              const siblings = ctx.getChildren(task.partOf as WorkId);
              if (areAllChildrenComplete(siblings)) {
                return {
                  action: "parent_complete",
                  details: `All tasks under ${parent.title} are complete. Feature ready for graduation.`,
                };
              }
            }
          }

          return { action: "task_summarized", details: summary.summary };
        }
      }
      return null;

    default:
      return null;
  }
}
