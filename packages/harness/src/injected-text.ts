/**
 * User-role messages that wolfd writes itself (ask answers, the superseded note, the task notice, sub-agent deliveries).
 * The model must answer these, so a bare "No response requested." to one is a failure (the empty-ack net in
 * providers/dropped-call.ts retries it). The producers (wolfd/cards.ts, wolfd/subagents.ts, superseded-note.ts) and the
 * check below use the same constants, so a changed wording cannot silently leave the net behind. A genuine owner message
 * is none of these: the prefixes are the exact wolfd forms, not loose words like "merge:".
 */
import { CONTEXT_NOTICE_HEAD, SUPERSEDED_NOTE_LINE, TASK_NOTICE_HEAD } from "./superseded-note.js";

export const ANSWER_SUBMITTED = "The user submitted your ";
export const ANSWER_SKIPPED = "The user skipped your ";
export const ANSWER_ANSWERED = "The user answered your ";
export const REVISE_NOT_APPLIED = "Note: your earlier ask_revise was NOT applied";

/** The text that follows `Sub-agent "<name>" ` in each delivery wolfd makes to a parent. */
export const SUBAGENT_KINDS = {
  completed: "completed (",
  failed: "failed after ",
  asks: "asks (",
  merge: "merge: ",
  stopped: "was stopped by the operator",
  couldNotStart: "could not start: ",
} as const;
export type SubagentKind = keyof typeof SUBAGENT_KINDS;

/** The head of a sub-agent delivery to the parent: `Sub-agent "scout" completed (`. */
export const subAgentHead = (name: string, kind: SubagentKind): string => `Sub-agent "${name}" ${SUBAGENT_KINDS[kind]}`;

const SUBAGENT_RE = new RegExp(`^Sub-agent "[^"\\n]*" (?:${Object.values(SUBAGENT_KINDS).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`);

/** Whether the user-role text starts with something wolfd injected (and therefore must be answered). */
export function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith(ANSWER_SUBMITTED) || t.startsWith(ANSWER_SKIPPED) || t.startsWith(ANSWER_ANSWERED) || t.startsWith(REVISE_NOT_APPLIED)
    || SUPERSEDED_NOTE_LINE.test(t) || TASK_NOTICE_HEAD.test(t) || CONTEXT_NOTICE_HEAD.test(t) || SUBAGENT_RE.test(t);
}
