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
 * - Object tool calls (`show_decision`) become `objects` on the assistant message of their first call: one entry per
 *   objectId, holding the latest rev's data. Objects are created when the call's RESULT lands, and only for a
 *   successful one (rev = successful completed calls with that id: the same rule as the live events). The full
 *   (uncapped) args are kept aside for it, since the call's own `args` are capped.
 * - Only entries present in the engine's snapshot/stream are visible; after compaction the older history is gone.
 * - `at` is the message's own timestamp (ms epoch) when present, else the time we first saw the entry.
 */
import { visibleFields, type ThreadMessage, type ThreadObject } from "@wolfpack/protocol";
import { CARD_ANSWER_KIND, USER_ENTRY_KIND, cardOfToolMessage, objectFromCall, type CardAnswerData, type EngineEvent } from "../engine/index.js";
import { answerValue } from "./cards.js";
import { stripTaskNotice } from "./task-notice.js";
import { stripSupersededNotes, type SupersededCard } from "../superseded-note.js";

type Entry = Extract<EngineEvent, { type: "message_end" }>["entry"];

const SKIPPED_RESULT = "(skipped by the user)";

export function messageFromEntry(entry: Entry, now: () => Date = () => new Date()): ThreadMessage | undefined {
  if (entry.kind !== USER_ENTRY_KIND && entry.kind !== "pi.assistant") return undefined;
  const msg = entry.model?.[0] as { role?: string; content?: unknown; timestamp?: number } | undefined;
  if (!msg) return undefined;
  const role = entry.kind === USER_ENTRY_KIND ? "user" : "assistant";
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

/**
 * Round identity of each folded call (the assistant entry's own timestamp). A call repeats only when the SAME round
 * is delivered again under another entry id; providers that reuse ids across rounds (DeepSeek's per-response
 * `call_0`) yield a different round (timestamp) each time and must keep every call.
 */
const callRound = new WeakMap<object, number>();
/** The uncapped arguments of each folded call (the capped `args` on the message cannot rebuild an object). */
const callFullArgs = new WeakMap<object, unknown>();

/** Fold one engine entry into the list: user/assistant messages (rounds merged), tool results onto their call. */
export function applyEntry(list: ThreadMessage[], entry: Entry, now: () => Date = () => new Date()): void {
  if (entry.kind === "pi.assistant") {
    const msg = entry.model?.[0] as { timestamp?: number } | undefined;
    if (!msg) return;
    const blocks = blocksOf(entry);
    const roundText = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    // A call is skipped only as a REPLAY of its own round (same callId, same round timestamp), never because the
    // id appeared in an earlier round or turn.
    const round = typeof msg.timestamp === "number" ? msg.timestamp : undefined;
    const isReplay = (id: string): boolean =>
      round !== undefined && list.some((m) => m.tools?.some((t) => t.callId === id && callRound.get(t) === round));
    const all = blocks.filter((b) => b.type === "toolCall" && b.id);
    const calls = all.filter((b) => !isReplay(b.id!));
    if (all.length > 0 && calls.length === 0) return; // the whole round is a replay
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
      else if (b.type === "toolCall" && b.id && !isReplay(b.id)) {
        const call = { callId: b.id, name: b.name ?? "tool", args: capArgs(b.arguments ?? {}), textOffset: base + before };
        if (round !== undefined) callRound.set(call, round);
        (target.tools ??= []).push(call);
        // Only object tools need their uncapped args (to build the object); don't pin every call's arguments.
        if (objectFromCall(b.name, b.arguments)) callFullArgs.set(call, b.arguments);
      }
    }
    if (roundText !== "") target.text = target.text === "" ? roundText : `${target.text}\n\n${roundText}`;
    return;
  }
  if (entry.kind.startsWith("pi.tool")) {
    const msg = entry.model?.[0] as { toolCallId?: string; isError?: boolean } | undefined;
    if (!msg?.toolCallId) return;
    for (let i = list.length - 1; i >= 0; i--) {
      // The most recent UNRESOLVED call with this id (reused ids pair each result to its own call); a result for an
      // already-resolved call (a replay) lands on the most recent one.
      const matches = (list[i].tools ?? []).filter((c) => c.callId === msg.toolCallId);
      const call = [...matches].reverse().find((c) => c.result === undefined) ?? matches.at(-1);
      if (!call) continue;
      const first = call.result === undefined; // a replayed result must not count twice
      const text = blocksOf(entry).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      call.result = sliceSafe(text, TOOL_CAP);
      if (text.length > TOOL_CAP) call.resultTruncated = true;
      call.isError = msg.isError === true;
      const obj = first && !call.isError ? objectFromCall(call.name, callFullArgs.get(call)) : undefined;
      if (obj) {
        // A revision replaces the object where it first appeared (latest rev wins); a new id lands with its call.
        // Invariant: every upsert (new or revision) rewrites `seq` on the kept object, so max(seq) over the thread is
        // always the latest upsert's ordinal, and a failed or replayed call (skipped above) never moves seq or rev.
        const byId = objectsById(list);
        const seq = Math.max(0, ...[...byId.values()].map((o) => o.seq ?? 0)) + 1; // this upsert's thread-wide ordinal
        const prior = byId.get(obj.objectId);
        if (prior) Object.assign(prior, { type: obj.type, data: obj.data, rev: prior.rev + 1, seq });
        else (list[i].objects ??= []).push({ ...obj, rev: 1, seq, ...(call.textOffset !== undefined ? { textOffset: call.textOffset } : {}) });
      }
      const card = cardOfToolMessage(entry.model?.[0]);
      if (card) call.card = card;
      return;
    }
    return;
  }
  if (entry.kind === CARD_ANSWER_KIND) {
    // A card answer is not a chat message: it resolves the call that raised the card (the answer is that call's result).
    for (const { callId, answers, skipped } of (entry.data as unknown as CardAnswerData | undefined)?.cards ?? []) {
      for (let i = list.length - 1; i >= 0; i--) {
        const call = [...(list[i].tools ?? [])].reverse().find((c) => c.callId === callId);
        if (!call) continue;
        if (skipped) {
          // `dismissed` stays true for clients that predate `closed`.
          call.dismissed = true;
          call.closed = "skipped";
          call.result = SKIPPED_RESULT;
          call.isError = false;
          break;
        }
        call.answer = answers;
        call.closed = "answered";
        call.result = call.card ? visibleFields(call.card, answers).map((f) => answerValue(f, answers[f.id])).join("; ") : Object.values(answers).map((a) => String(a.value)).join("; ");
        call.isError = false;
        break;
      }
    }
    return;
  }
  const m = messageFromEntry(entry, now);
  if (m) {
    // A plain user message supersedes every card still waiting: they are skipped, not answerable.
    if (m.role === "user") {
      // Only messages after the previous user message can hold cards still waiting (earlier ones were dismissed then).
      const replaced: SupersededCard[] = [];
      for (let i = list.length - 1; i >= 0 && list[i].role !== "user"; i--) {
        for (const call of list[i].tools ?? []) {
          if (!call.card || call.answer || call.closed) continue;
          Object.assign(call, { dismissed: true, closed: "superseded" });
          replaced.push({ tool: call.card.tool, callId: call.callId });
        }
      }
      // wolfd put a note for exactly these cards at the head of the message (server.ts submit): the operator sees what they typed.
      if (replaced.length) m.text = stripSupersededNotes(m.text, replaced);
      m.text = stripTaskNotice(m.text);
    }
    list.push(m);
  }
}

/** Every object in the list by id (one entry per id by construction). */
function objectsById(list: readonly ThreadMessage[]): Map<string, ThreadObject> {
  const out = new Map<string, ThreadObject>();
  for (const m of list) for (const o of m.objects ?? []) out.set(o.objectId, o);
  return out;
}

export function messagesFromEntries(entries: readonly Entry[]): ThreadMessage[] {
  const out: ThreadMessage[] = [];
  for (const e of entries) applyEntry(out, e);
  return out;
}
