/**
 * ThreadMessage reconstruction from engine entries.
 *
 * Fidelity limits (text-only protocol messages):
 * - Only `pi.user` and `pi.assistant` entries become messages; system, tool-result and bookkeeping entries are dropped.
 * - Text is the concatenation of text blocks; thinking and tool calls are dropped, and an assistant entry with no text
 *   (a pure tool-call round) yields no message. A multi-round turn therefore shows one assistant message per round
 *   that spoke, not one per turn.
 * - Consecutive assistant messages (the rounds of one turn, split by tool calls) are merged into ONE message, text
 *   joined by a blank line, so the thread shows one assistant message per turn; a steer's user message splits them.
 * - Ids are `entry-<engine entry id>` (of the first merged entry) (NOT the submit ack's messageId, which is the engine submission id).
 * - Only entries present in the engine's snapshot/stream are visible; after compaction the older history is gone.
 * - `at` is the message's own timestamp (ms epoch) when present, else the time we first saw the entry.
 */
import type { ThreadMessage } from "@wolfpack/protocol";
import type { EngineEvent } from "../engine/index.js";

type Entry = Extract<EngineEvent, { type: "message_end" }>["entry"];

export function messageFromEntry(entry: Entry, now: () => Date = () => new Date()): ThreadMessage | undefined {
  if (entry.kind !== "pi.user" && entry.kind !== "pi.assistant") return undefined;
  const msg = entry.model?.[0] as { role?: string; content?: unknown; timestamp?: number } | undefined;
  if (!msg) return undefined;
  const role = entry.kind === "pi.user" ? "user" : "assistant";
  let text = "";
  if (typeof msg.content === "string") text = msg.content;
  else if (Array.isArray(msg.content)) {
    text = (msg.content as Array<{ type: string; text?: string }>)
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
  }
  if (role === "assistant" && text === "") return undefined;
  const at = typeof msg.timestamp === "number" ? new Date(msg.timestamp) : now();
  return { id: `entry-${entry.id}`, role, text, at: at.toISOString() };
}

/** Append `m`, merging it into a directly preceding assistant message. */
export function appendMessage(list: ThreadMessage[], m: ThreadMessage): void {
  const last = list.at(-1);
  if (last && last.role === "assistant" && m.role === "assistant") list[list.length - 1] = { ...last, text: `${last.text}\n\n${m.text}` };
  else list.push(m);
}

export function messagesFromEntries(entries: readonly Entry[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const e of entries) {
    const m = messageFromEntry(e);
    if (m) appendMessage(out, m);
  }
  return out;
}
