import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Which work item a subagent works on: a memory tag only (PI_SUBAGENT_TASK), never a binding.
 * Id shape matches the KB schema (packages/kb/src/schema/work.ts): work-<domain>-<7 alphanumerics>.
 */
const WORK_ID = /(?<![A-Za-z0-9-])work-[a-z0-9]+-[0-9A-Za-z]{7}(?![A-Za-z0-9])/;
const WORK_ID_EXACT = new RegExp(`^${WORK_ID.source}$`);

/**
 * The task the parent session is bound to right now, from the memory extension's per-session binding file
 * (`<den>/factory/sessions/<sid>/active-task.json`; unbinding and finishing a task delete it, see work-system.ts
 * `unbindTask`). Undefined when unbound, unreadable or not a work id, so a stale or finished binding never tags a child.
 */
export function readParentBoundTask(den: string | undefined, sessionId: string): string | undefined {
  if (!den) return undefined;
  try {
    const id = JSON.parse(readFileSync(join(den, "factory", "sessions", sessionId, "active-task.json"), "utf8"))?.workId;
    return typeof id === "string" && WORK_ID_EXACT.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A valid explicit id, else the first full work id in the brief by position, else the parent's bound task
 * (`parentBound`, when it is a valid id), else undefined.
 */
export function resolveSubagentTask(input: { explicit?: string; brief: string; parentBound?: string | null }): string | undefined {
  const explicit = input.explicit?.trim();
  if (explicit && WORK_ID_EXACT.test(explicit)) return explicit;
  const inBrief = WORK_ID.exec(input.brief)?.[0];
  if (inBrief) return inBrief;
  const bound = input.parentBound?.trim();
  return bound && WORK_ID_EXACT.test(bound) ? bound : undefined;
}
