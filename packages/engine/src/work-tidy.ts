/**
 * workTidy engine step: one pass over a finished feature's Record that merges duplicates and drops superseded
 * decisions. Input lines are numbered l1…; each output line names the input lines it came from.
 */
import { WORK_DISTILL_GROUPS, type WorkDistillGroup } from "./work-log.js";

export interface WorkTidyLine {
  group: WorkDistillGroup;
  text: string;
  from: string[];
}

export const WORK_TIDY_MAX_CHARS = 240;

export const WORK_TIDY_SYSTEM = `You tidy the Record of a FINISHED feature, once. The Record is a list of short lines grouped under headings (Decisions, Changes, Findings, Problems & fixes); every input line is numbered l1, l2, … You are also given the feature title and its Outcomes one-liners.

Rewrite the Record so it is shorter and reads as the final account:
- Merge lines that say the same thing into one.
- Drop a decision that a later line supersedes or reverses; keep the final one.
- Drop lines that only restate an Outcome or record a step with no lasting value.
- Keep every concrete fact that is still true (names, numbers, paths, reasons). Never invent anything.
- Aim for at most 60% of the input length and never more than 4000 characters in total.
- Each output line is one sentence of at most 240 characters.

Answer with JSON only, no prose:
{"lines":[{"group":"Decisions|Changes|Findings|Problems & fixes","text":"…","from":["l2","l9"]}]}
"from" lists the input line numbers each output line comes from (at least one).`;

const one = (s: string) => s.replace(/\s+/g, " ").trim();

export function buildWorkTidyPrompt(input: { title: string; outcomes: string[]; lines: Array<{ group: string; text: string }> }): string {
  const outcomes = input.outcomes.length ? input.outcomes.map((o) => `- ${one(o)}`).join("\n") : "(none)";
  const byGroup = new Map<string, string[]>();
  input.lines.forEach((l, i) => byGroup.set(l.group, [...(byGroup.get(l.group) ?? []), `[l${i + 1}] ${one(l.text)}`]));
  const rec = [...byGroup].map(([g, ls]) => `### ${g}\n${ls.join("\n")}`).join("\n\n");
  return [`FEATURE: ${one(input.title)}`, "", "OUTCOMES:", outcomes, "", "RECORD:", rec || "(empty)"].join("\n");
}

/** Valid entries only (known group, non-empty text of at most 240 chars). Never throws. */
export function parseWorkTidyOutput(text: string): WorkTidyLine[] {
  let s = String(text ?? "").trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/.exec(s);
  if (fence) s = fence[1]!.trim();
  let lines: unknown;
  try {
    lines = (JSON.parse(s) as { lines?: unknown } | null)?.lines;
  } catch {
    return [];
  }
  if (!Array.isArray(lines)) return [];
  const out: WorkTidyLine[] = [];
  for (const raw of lines) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (!WORK_DISTILL_GROUPS.includes(r.group as WorkDistillGroup) || typeof r.text !== "string") continue;
    const t = one(r.text);
    if (!t || t.length > WORK_TIDY_MAX_CHARS) continue;
    const from = Array.isArray(r.from) ? r.from.filter((f): f is string => typeof f === "string") : [];
    out.push({ group: r.group as WorkDistillGroup, text: t, from });
  }
  return out;
}
