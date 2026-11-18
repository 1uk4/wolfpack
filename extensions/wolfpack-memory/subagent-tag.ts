/**
 * Subagent memory (`memory.subagentMemory: on`): which subagents observe, and the work tag their observations carry.
 * Separate from the binding: a subagent never binds (SUBAGENT_NO_BIND); this only says what to stamp on its observations.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkClient } from "./work-client.js";

/** Agents whose sessions observe. `scout` observes its final message only (see {@link FINAL_ONLY_AGENTS}). */
export const OBSERVING_AGENTS = new Set(["worker", "planner", "investigator", "reviewer", "scout"]);
export const FINAL_ONLY_AGENTS = new Set(["scout"]);

/** Observe about every this many responses, or once this many new tokens (~4 chars each) have built up. */
export const SUBAGENT_OBSERVE_EVERY_TURNS = 3;
export const SUBAGENT_OBSERVE_TOKENS = 1500;

export interface SubagentTag {
  agent: string;
  taskId: string;
}

/** Whether `agent` runs the observer for `taskId` (an eligible agent type and a task). */
export function subagentEligible(agent: string | undefined, taskId: string | undefined): boolean {
  return !!agent && !!taskId && OBSERVING_AGENTS.has(agent);
}

/**
 * The tag getter for subagent observations: the task this pi subagent works on (PI_SUBAGENT_TASK), or null when the agent
 * type does not observe or has no task. Not the binding: getBoundWork stays null for a subagent.
 */
export function subagentTask(env: NodeJS.ProcessEnv = process.env): string | null {
  return subagentEligible(env.PI_SUBAGENT_AGENT, env.PI_SUBAGENT_TASK) ? env.PI_SUBAGENT_TASK! : null;
}

/** The durable subagent behind a (task-owned) conversation, from wolfd's registry. Null: not a known child or not eligible. */
export function durableSubagent(wolfDen: string, conversationId: number): SubagentTag | null {
  try {
    const reg = JSON.parse(readFileSync(join(wolfDen, "wolfd", "subagents.json"), "utf8")) as { children?: Array<Record<string, unknown>> };
    const rec = reg.children?.find((c) => String(c.conversationId) === String(conversationId));
    const agent = typeof rec?.agent === "string" ? rec.agent : undefined;
    const taskId = typeof rec?.taskId === "string" ? rec.taskId : undefined;
    return subagentEligible(agent, taskId) ? { agent: agent!, taskId: taskId! } : null;
  } catch {
    return null;
  }
}

/** Every child in wolfd's registry that serves a task: its thread name and task id (empty when unreadable). */
export function knownChildren(wolfDen: string): Array<{ name: string; taskId?: string }> {
  try {
    const reg = JSON.parse(readFileSync(join(wolfDen, "wolfd", "subagents.json"), "utf8")) as { children?: Array<Record<string, unknown>> };
    return (reg.children ?? []).flatMap((c) => (typeof c.name === "string" ? [{ name: c.name, ...(typeof c.taskId === "string" ? { taskId: c.taskId } : {}) }] : []));
  } catch {
    return [];
  }
}

/** The task's `partOf`, looked up once per task id (a failed lookup is remembered too: the feature stays unset). */
export function featureResolver(client: () => Pick<WorkClient, "get">): (taskId: string) => Promise<string | undefined> {
  const cache = new Map<string, Promise<string | undefined>>();
  return (taskId) => {
    let hit = cache.get(taskId);
    if (!hit) {
      hit = (async () => {
        try {
          const item = await client().get(taskId);
          return typeof item.partOf === "string" && item.partOf ? item.partOf : undefined;
        } catch {
          return undefined;
        }
      })();
      cache.set(taskId, hit);
    }
    return hit;
  };
}
