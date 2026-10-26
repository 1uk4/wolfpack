/**
 * ThreadMessage reconstruction from engine entries.
 *
 * Fidelity limits (text + capped tool calls; no thinking):
 * - Only `pi.user` and `pi.assistant` entries become messages; system and bookkeeping entries are dropped.
 * - Text is the concatenation of text blocks; thinking is dropped. Tool calls ride `tools` (capped args/result, paired
 *   with their `pi.tool_result` entry by callId, `textOffset` = text length at the call). An assistant entry with no
 *   text and no tool calls yields no message; a pure tool round yields one with `text: ""`.
 * - Consecutive assistant messages (the rounds of one turn, split by tool calls) are merged into ONE message, text
 *   joined by a blank line, so the thread shows one assistant message per turn; a steer's user message splits them.
 * - Ids are `entry-<engine entry id>` (of the first merged entry; a turn that starts with a tool-only round uses that
 *   entry's id, since such rounds now yield a message) (NOT the submit ack's messageId, which is the engine submission id).
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

/** Cut at `n` UTF-16 units without splitting a surrogate pair. */
function sliceSafe(s: string, n: number): string {
  if (s.length <= n) return s;
  let end = n;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return s.slice(0, end);
}

/**
 * Cap tool args but keep them an OBJECT: every string value (nested included) is cut to ARG_STRING_CAP; if the JSON
 * is still over TOOL_CAP, the largest string values are shortened first until it fits. Any cut sets `_truncated: true`
 * at the top level.
 */
function capArgs(args: unknown): unknown {
  let cut = false;
  const cap = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (v.length <= ARG_STRING_CAP) return v;
      cut = true;
      return `${sliceSafe(v, ARG_STRING_CAP)}…`;
    }
    if (Array.isArray(v)) return v.map(cap);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cap(x)]));
    return v;
  };
  const capped = cap(args);
  if (!capped || typeof capped !== "object" || Array.isArray(capped)) return capped;
  const obj = capped as Record<string, unknown>;
  const size = () => (JSON.stringify(obj) ?? "").length;
  // Shorten the largest string values (top-level and nested) until the total fits.
  const strings: Array<{ holder: Record<string, unknown> | unknown[]; key: string | number }> = [];
  const collect = (h: Record<string, unknown> | unknown[]) => {
    for (const [k, x] of Object.entries(h)) {
      if (typeof x === "string") strings.push({ holder: h, key: Array.isArray(h) ? Number(k) : k });
      else if (x && typeof x === "object") collect(x as Record<string, unknown>);
    }
  };
  collect(obj);
  while (size() > TOOL_CAP) {
    const get = (r: (typeof strings)[number]) => (r.holder as never)[r.key] as string;
    const big = strings.reduce((m, r) => (get(r).length > get(m).length ? r : m), strings[0]!);
    if (!big || get(big).length <= 16) break;
    (big.holder as Record<string | number, unknown>)[big.key] = `${sliceSafe(get(big), Math.max(16, Math.floor(get(big).length / 2)))}…`;
    cut = true;
  }
  return cut ? { ...obj, _truncated: true } : obj;
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
    // A call already folded (the same round delivered under another entry id, or replayed over a rebase) is never
    // added twice: callId is the identity, the entry id only dedups the entry.
    const known = new Set(list.flatMap((m) => m.tools ?? []).map((t) => t.callId));
    const calls = blocks.filter((b) => b.type === "toolCall" && b.id && !known.has(b.id));
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
      else if (b.type === "toolCall" && b.id && !known.has(b.id)) {
        known.add(b.id);
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
      call.result = sliceSafe(text, TOOL_CAP);
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
