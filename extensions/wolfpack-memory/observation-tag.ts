/**
 * Pure tag decisions for unbound observations (no I/O, so they are tested directly; unified.ts does the lookups).
 *   - a subagent's report narrated in an unbound parent thread inherits that subagent's task tag;
 *   - a line naming several work items gets the feature they all share, else no tag. Never a guess.
 */
export interface PoolTagLike {
  taskId?: string;
  featureId?: string;
}

export interface ChildRef {
  name: string;
  taskId?: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The tag for a line that names a subagent (by its thread name) whose task is known. Several subagents of one task
 * count as one; subagents of different tasks, a subagent without a task, or no subagent at all give null.
 */
export function subagentReportTag(line: string, children: readonly ChildRef[], featureOf: (taskId: string) => string | undefined): { taskId: string; featureId?: string } | null {
  const named = children.filter((c) => c.name && new RegExp(`(?<![A-Za-z0-9-])${escapeRe(c.name)}(?![A-Za-z0-9-])`).test(line));
  if (!named.length) return null;
  const tasks = new Set(named.map((c) => c.taskId ?? ""));
  if (tasks.size !== 1) return null;
  const [taskId] = [...tasks];
  if (!taskId) return null;
  const featureId = featureOf(taskId);
  return { taskId, ...(featureId ? { featureId } : {}) };
}

/** The feature every tag shares, as a feature-only tag; null when they share none, one has none, or a lookup failed (null). */
export function sharedFeature(tags: ReadonlyArray<PoolTagLike | null>): { featureId: string } | null {
  if (!tags.length) return null;
  let feature: string | undefined;
  for (const t of tags) {
    const f = t?.featureId;
    if (!f) return null;
    if (feature !== undefined && feature !== f) return null;
    feature = f;
  }
  return feature ? { featureId: feature } : null;
}
