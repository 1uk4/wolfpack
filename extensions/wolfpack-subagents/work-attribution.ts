/**
 * Work-item attribution of a subagent's work.
 *
 * `subagent({ workItem })` tells the subagent which work item it works on and,
 * when it finishes, hands its final report to the parent wolf's memory as
 * observations tagged with that item (and its feature). Memory folds them into
 * the Record of the feature (or of the item, under the Inbox) with the same
 * consolidation as the orchestrator's own observations. The steer message that
 * delivers the report is marked, so the orchestrator's observer does not
 * extract the same report a second time.
 *
 * Kept free of host imports so it can be tested alone.
 */

/**
 * The event-bus channel the memory extension listens on. Must equal
 * WORK_OBSERVATIONS_CHANNEL in @wolfpack/memory (a test keeps them equal);
 * this extension does not depend on that package.
 */
export const WORK_OBSERVATIONS_CHANNEL = "wolfpack:work-observations";

/** Set (true) in `details` of the steer message whose report was recorded. Equals RECORDED_REPORT_KEY in @wolfpack/memory. */
export const RECORDED_REPORT_KEY = "recordedToWork";

export interface WorkItemRef {
  id: string;
  title?: string;
  /** The item's parent (the feature, or the Inbox container). */
  partOf?: string | null;
}

export interface EventBus {
  emit(channel: string, data: unknown): void;
}

/** The item's title and parent from the Work API; null when it cannot be had quickly. */
export async function fetchWorkItemRef(
  id: string,
  opts: { endpoint?: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<WorkItemRef | null> {
  const endpoint = (opts.endpoint ?? process.env.WORK_ENDPOINT ?? "").replace(/\/$/, "");
  const token = opts.token ?? process.env.WORK_TOKEN ?? "";
  if (!endpoint || !token) return null;
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${endpoint}/work/${encodeURIComponent(id)}`, {
      headers: { "X-API-Key": token },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 1500),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { item?: { id?: string; title?: string; partOf?: string | null } };
    if (!data.item?.title) return null;
    return { id, title: String(data.item.title), partOf: data.item.partOf ?? null };
  } catch {
    return null;
  }
}

/** The task with the one-line attribution first. */
export function prependWorkItem(task: string, ref: WorkItemRef): string {
  return `You're working on ${ref.id}${ref.title ? ` (${ref.title})` : ""}.\n\n${task}`;
}

const MAX_LINES = 10;
const MAX_LINE = 1500;
const MIN_BLOCK = 20;

/**
 * A report as observation lines: its paragraphs, short ones joined to their
 * neighbours (a heading with its list), each prefixed with the source.
 */
export function reportToLines(report: string, name: string): string[] {
  const blocks = report
    .split(/\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.length >= MIN_BLOCK) lines.push(cur);
    cur = "";
  };
  for (const b of blocks) {
    if (cur && cur.length + b.length + 2 > MAX_LINE) flush();
    cur = cur ? `${cur}\n${b}` : b;
    if (cur.length >= MAX_LINE / 2) flush();
  }
  flush();
  return lines.slice(0, MAX_LINES).map((l) => `[subagent ${name}] ${l.length > MAX_LINE ? l.slice(0, MAX_LINE - 1) + "…" : l}`);
}

export interface FinishedRun {
  exitCode: number;
  summary: string;
  errorMessage?: string;
}

/**
 * A subagent with a workItem finished: hand its report to memory (when it
 * succeeded) and return what to merge into the steer message's `details`.
 * The marker is set whenever a workItem was given, so the observer never
 * extracts the report itself, whether or not it was usable as Record material.
 */
export function deliverWorkReport(bus: EventBus | undefined, ref: WorkItemRef, name: string, result: FinishedRun): Record<string, unknown> {
  const usable = result.exitCode === 0 && !result.errorMessage && result.summary.trim().length > 0;
  if (usable && bus) {
    const contents = reportToLines(result.summary, name);
    if (contents.length > 0) {
      bus.emit(WORK_OBSERVATIONS_CHANNEL, {
        work: ref.id,
        ...(ref.partOf ? { feature: ref.partOf } : {}),
        source: `subagent:${name}`,
        contents,
      });
    }
  }
  return { workItem: ref.id, [RECORDED_REPORT_KEY]: true };
}
