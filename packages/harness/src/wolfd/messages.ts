/**
 * ThreadMessage reconstruction from engine entries.
 *
 * Fidelity limits (text-only protocol messages):
 * - Only `pi.user` and `pi.assistant` entries become messages; system and bookkeeping entries are dropped.
 * - Text is the concatenation of text blocks; thinking is dropped. Tool calls ride `tools` (capped args/result, paired
 *   with their `pi.tool_result` entry by callId, `textOffset` = text length at the call). An assistant entry with no
 *   text and no tool calls yields no message; a pure tool round yields one with `text: ""`.
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

const TOOL_CAP = 4096;
const ARG_STRING_CAP = 1024;

function capArgs(args: unknown): unknown {
  const cap = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > ARG_STRING_CAP ? `${v.slice(0, ARG_STRING_CAP)}…` : v;
    if (Array.isArray(v)) return v.map(cap);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cap(x)]));
    return v;
  };
  const capped = cap(args);
  const json = JSON.stringify(capped) ?? "";
  return json.length > TOOL_CAP ? `${json.slice(0, TOOL_CAP)}…` : capped;
}

function blocksOf(entry: Entry): Array<{ type: string; text?: string; id?: string; name?: string; arguments?: unknown }> {
  const msg = entry.model?.[0] as { content?: unknown } | undefined;
  return Array.isArray(msg?.content) ? (msg!.content as never) : [];
}

/** Fold one engine entry into the list: user/assistant messages (rounds merged), tool results onto their call. */
export function applyEntry(list: ThreadMessage[], entry: Entry, now: () => Date = () => new Date()): void {
  if (entry.kind === "pi.assistant") {
    const msg = entry.model?.[0] as { timestamp?: number } | undefined;
    if (!msg) return;
    const blocks = blocksOf(entry);
    const roundText = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const calls = blocks.filter((b) => b.type === "toolCall");
    if (roundText === "" && calls.length === 0) return;
    const last = list.at(-1);
    const target: ThreadMessage =
      last && last.role === "assistant"
        ? last
        : { id: `entry-${entry.id}`, role: "assistant", text: "", at: (typeof msg.timestamp === "number" ? new Date(msg.timestamp) : now()).toISOString() };
    if (target !== last) list.push(target);
    const base = roundText === "" ? target.text.length : target.text === "" ? 0 : target.text.length + 2;
    let before = 0;
    for (const b of blocks) {
      if (b.type === "text") before += (b.text ?? "").length;
      else if (b.type === "toolCall" && b.id) {
        (target.tools ??= []).push({ callId: b.id, name: b.name ?? "tool", args: capArgs(b.arguments ?? {}), textOffset: base + before });
      }
    }
    if (roundText !== "") target.text = target.text === "" ? roundText : `${target.text}\n\n${roundText}`;
    return;
  }
  if (entry.kind.startsWith("pi.tool")) {
    const msg = entry.model?.[0] as { toolCallId?: string; isError?: boolean } | undefined;
    if (!msg?.toolCallId) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const call = list[i].tools?.find((c) => c.callId === msg.toolCallId);
      if (!call) continue;
      const text = blocksOf(entry).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      call.result = text.length > TOOL_CAP ? text.slice(0, TOOL_CAP) : text;
      if (text.length > TOOL_CAP) call.resultTruncated = true;
      call.isError = msg.isError === true;
      return;
    }
    return;
  }
  const m = messageFromEntry(entry, now);
  if (m) list.push(m);
}

export function messagesFromEntries(entries: readonly Entry[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const e of entries) applyEntry(out, e);
  return out;
}
