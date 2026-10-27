/**
 * The note put at the head of a user message that replaced pending cards, so the model knows ("(Your pending <tool>
 * question (call X) was superseded by this message.)", one line per card, then a blank line). Dependency-free: wolfd's
 * history and the memory observer both strip it. Notes are added only when the message is built, i.e. for a submit that
 * finds cards pending; a steer/followUp during a run has none (the run's own first message already superseded them).
 */
export interface SupersededCard {
  tool: string;
  callId: string;
}

const noteLine = (c: SupersededCard): string => `(Your pending ${c.tool} question (call ${c.callId}) was superseded by this message.)`;

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
  if (!cards) return text.replace(ANY_NOTE_HEAD, "");
  const mine = new Set(cards.map(noteLine));
  const lines = text.split("\n");
  let n = 0;
  while (n < lines.length && mine.delete(lines[n])) n++;
  if (n === 0 || lines[n] !== "") return text;
  return lines.slice(n + 1).join("\n");
}
