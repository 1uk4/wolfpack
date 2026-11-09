/**
 * The note put at the head of a user message that replaced pending cards, so the model knows ("(Your pending <tool>
 * question (call X) was superseded by this message.)", one line per card, then a blank line). Dependency-free: wolfd's
 * history and the memory observer both strip it. Notes are added only when the message is built, i.e. for a submit that
 * finds cards pending; a steer/followUp during a run has none (the run's own first message already superseded them).
 */
export interface SupersededCard {
  tool: string;
  callId: string;
  /** One line on how far a paged `ask` got ("Q => answer; Q2 => skipped; Q3 => unanswered"). */
  detail?: string;
  /**
   * A paged `ask`: its note line carries `detail`, which only wolfd had at send time. Stripping then matches the line by
   * its fixed frame (tool, call id, any detail) and never re-derives the detail, so it works after the card is gone.
   */
  paged?: true;
}

const noteLine = (c: SupersededCard): string =>
  `(Your pending ${c.tool} question (call ${c.callId}${c.detail ? `; state when replaced: ${c.detail.replace(/\s+/g, " ")}` : ""}) was superseded by this message.)`;

/** The text to prepend for these cards ("" when none). */
export function supersededNotes(cards: readonly SupersededCard[]): string {
  return cards.length ? `${cards.map(noteLine).join("\n")}\n\n` : "";
}

const ANY_NOTE_HEAD = /^(?:\(Your pending [^\n]*? question \(call [^\n]*?\) was superseded by this message\.\)\n)+\n/;

/**
 * The message without its superseded notes. With `cards` (the ones actually superseded by this message) only their
 * exact note lines are removed, so a user typing similar text is left alone. Without it (the memory observer has no
 * card state) any well-formed note block at the head goes.
 */
export function stripSupersededNotes(text: string, cards?: readonly SupersededCard[]): string {
  if (!cards) return stripTaskNotice(text.replace(ANY_NOTE_HEAD, ""));
  const esc = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mine = cards.map((c) => (c.paged ? new RegExp(`^\\(Your pending ${esc(c.tool)} question \\(call ${esc(c.callId)}(?:; state when replaced: [^\\n]*)?\\) was superseded by this message\\.\\)$`) : c));
  const lines = text.split("\n");
  let n = 0;
  while (n < lines.length) {
    const i = mine.findIndex((m) => (m instanceof RegExp ? m.test(lines[n]) : noteLine(m) === lines[n]));
    if (i < 0) break;
    mine.splice(i, 1);
    n++;
  }
  if (n === 0 || lines[n] !== "") return text;
  return lines.slice(n + 1).join("\n");
}

/**
 * The task-update notice wolfd puts after any superseded notes and before the operator's text ("Task update: stage a → b;
 * 2/3 tasks shipped; feature tasks changed; Record updated"). Only this generated vocabulary is stripped, so operator text
 * that starts with "Task update:" survives.
 */
const PART = String.raw`(?:stage \S+ → \S+|\d+/\d+ tasks shipped|feature tasks changed|Record updated)`;
const NOTICE_HEAD = new RegExp(String.raw`^Task update: ${PART}(?:; ${PART})*\n\n`);
export const withTaskNotice = (notice: string, text: string): string => (notice ? `${notice}\n\n${text}` : text);
export const stripTaskNotice = (text: string): string => text.replace(NOTICE_HEAD, "");
