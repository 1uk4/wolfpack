/**
 * Which work items a tool call touched (live pack map work-touch trails). Pure and conservative: anything unclear
 * yields nothing. Tool args are inspected here and never kept.
 *
 * Work-item tools that act on an item: note, update, stage, done, claim, release, schedule, link, move, graduate.
 * Target id: args `id` / `ids`, else the thread's bound item for tools that default to it. `task_bind` is left out (the
 * tap already sends `bound` for it), `task_create` (the id is not known yet) and `task_query` (read-only listing).
 */
const WORK_TOOLS = new Set(["task_note", "task_update", "task_stage", "task_done", "task_claim", "task_release", "task_schedule", "task_link", "task_move", "task_graduate"]);
/**
 * Tools whose id defaults to the bound item. task_claim and task_release are not in it: they take an explicit id (claiming binds it, releasing
 * unbinds it), so with no id there is no item to name. task_graduate likewise needs an id.
 */
const DEFAULTS_TO_BOUND = new Set(["task_note", "task_update", "task_stage", "task_done", "task_schedule", "task_link", "task_move"]);
const WORK_ID = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_WORK_TARGETS = 5;

export interface WorkTarget { kind: "work-item"; id: string; domain?: string }

export function workTargetsOfTool(toolName: string, args: unknown, bound?: string): WorkTarget[] {
  try {
    if (!WORK_TOOLS.has(toolName)) return [];
    const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
    const ids: string[] = [];
    if (typeof a.id === "string") ids.push(a.id);
    if (Array.isArray(a.ids)) for (const i of a.ids) if (typeof i === "string") ids.push(i);
    if (ids.length === 0 && DEFAULTS_TO_BOUND.has(toolName) && bound) ids.push(bound);
    const out: WorkTarget[] = [];
    for (const id of ids) {
      if (!WORK_ID.test(id) || out.some((t) => t.id === id)) continue;
      const m = /^work-([A-Za-z0-9]+)-.+$/.exec(id);
      out.push({ kind: "work-item", id, ...(m ? { domain: m[1]! } : {}) });
      if (out.length >= MAX_WORK_TARGETS) break;
    }
    return out;
  } catch {
    return [];
  }
}
