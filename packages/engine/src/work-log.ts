/**
 * Prompt builders and output parsers for the workLog and workDistill engine steps.
 * Nothing calls them yet; the system prompts live in prompts.ts.
 */

export const WORK_LOG_KINDS = ["decision", "change", "finding", "problem"] as const;
export type WorkLogKind = (typeof WORK_LOG_KINDS)[number];
export const WORK_LOG_MAX_LINES = 6;
export const WORK_LOG_MAX_CHARS = 240;

export const WORK_DISTILL_GROUPS = ["Decisions", "Changes", "Findings", "Problems & fixes"] as const;
export type WorkDistillGroup = (typeof WORK_DISTILL_GROUPS)[number];
export const WORK_DISTILL_MAX_LINES = 5;

export interface WorkLogLine {
  kind: WorkLogKind;
  text: string;
  from: string[];
}
export interface WorkDistillLine {
  group: WorkDistillGroup;
  text: string;
}

export interface WorkLogPromptInput {
  title: string;
  /** New observations; numbered o1, o2… in order. */
  observations: string[];
  /** Existing log lines; only the last 8 are sent. */
  recentLines: string[];
}

const one = (s: string) => s.replace(/\s+/g, " ").trim();

export function buildWorkLogPrompt(input: WorkLogPromptInput): string {
  const recent = input.recentLines.slice(-8).map((l) => `- ${one(l)}`);
  return [
    `TASK: ${one(input.title)}`,
    "",
    "RECENT LOG LINES (do not repeat):",
    recent.length ? recent.join("\n") : "(none)",
    "",
    "NEW OBSERVATIONS:",
    input.observations.map((o, i) => `[o${i + 1}] ${one(o)}`).join("\n") || "(none)",
  ].join("\n");
}

export interface WorkDistillPromptInput {
  taskId: string;
  title: string;
  /** The task's log lines. */
  log: string[];
  /** The feature's `## Outcomes` one-liners. */
  outcomes: string[];
  /** The feature Record's headings. */
  recordHeadings: string[];
  /** The feature Record's bullets; only the last 6 are sent. */
  recordBullets: string[];
}

export function buildWorkDistillPrompt(input: WorkDistillPromptInput): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${one(x)}`).join("\n") : "(none)");
  return [
    `TASK: ${input.taskId} — ${one(input.title)}`,
    "",
    "TASK LOG:",
    list(input.log),
    "",
    "FEATURE OUTCOMES:",
    list(input.outcomes),
    "",
    "FEATURE RECORD HEADINGS:",
    list(input.recordHeadings),
    "",
    "FEATURE RECORD, LAST BULLETS:",
    list(input.recordBullets.slice(-6)),
  ].join("\n");
}

/** Parse a model answer into its `lines` array; tolerates a fenced block. Null when it is not usable JSON. */
function rawLines(text: string): unknown[] | null {
  let s = text.trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(s);
  if (fence) s = fence[1]!.trim();
  try {
    const v: unknown = JSON.parse(s);
    const lines = (v as { lines?: unknown } | null)?.lines;
    return Array.isArray(lines) ? lines : null;
  } catch {
    return null;
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** Valid entries only, at most 6, text over 240 characters dropped. Never throws. */
export function parseWorkLogOutput(text: string): WorkLogLine[] {
  const out: WorkLogLine[] = [];
  for (const raw of rawLines(text) ?? []) {
    if (!isObj(raw) || !WORK_LOG_KINDS.includes(raw.kind as WorkLogKind) || typeof raw.text !== "string") continue;
    const t = one(raw.text);
    if (!t || t.length > WORK_LOG_MAX_CHARS) continue;
    const from = Array.isArray(raw.from) ? raw.from.filter((f): f is string => typeof f === "string") : [];
    out.push({ kind: raw.kind as WorkLogKind, text: t, from });
    if (out.length === WORK_LOG_MAX_LINES) break;
  }
  return out;
}

/** Valid entries only, at most 5. Never throws. */
export function parseWorkDistillOutput(text: string): WorkDistillLine[] {
  const out: WorkDistillLine[] = [];
  for (const raw of rawLines(text) ?? []) {
    if (!isObj(raw) || !WORK_DISTILL_GROUPS.includes(raw.group as WorkDistillGroup) || typeof raw.text !== "string") continue;
    const t = one(raw.text);
    if (!t) continue;
    out.push({ group: raw.group as WorkDistillGroup, text: t });
    if (out.length === WORK_DISTILL_MAX_LINES) break;
  }
  return out;
}
