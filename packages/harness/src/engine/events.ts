/**
 * Engine events -> protocol ThreadEvents.
 *
 * `watchEvents` is EXPERIMENTAL upstream; this file is the only consumer of its event shapes. Rules (all taken from
 * the durable-bridge spike, spikes/durable-bridge/FINDINGS.md, and pinned by fixture tests):
 *
 * - A protocol turn is an engine RUN (run_start..run_end), not an engine turn: one run spans several model rounds
 *   (tool calls) and a steer lands inside it. Engine turn_start/turn_end are ignored. turnId = `turn-<first input id>`.
 * - turn-end is deferred past run_end until the run's submission settles, because the reason lives there:
 *   done -> complete, unanswered(reason aborted) -> aborted, anything else unanswered -> error. If the stream ends
 *   first, the reason falls back to what the last assistant message said (stopReason aborted/error).
 * - Text streams best-effort: message_start may already carry partial text (emitted as a text-delta if nonempty),
 *   message_update text_delta/thinking_delta append. Zero-delta turns are legal. Final text is ALWAYS reconciled from
 *   message_end: any tail not yet streamed is emitted as one trailing text-delta (partial updates are throttled).
 * - Tool events: tool-start (name/callId/args), tool-update carries the FULL accumulated output (engine sends
 *   set/append/trimStart ops; details-only updates are dropped), tool-end carries the result text + isError from the
 *   result entry (absent entry = faulted tool = isError). Nested tool calls (parentToolCallId) are not surfaced.
 * - Object tools (`show_decision`) additionally yield an `object-upsert` just before their tool-end, for a SUCCESSFUL
 *   call only (rev = successful completed calls so far per objectId, seeded from the attach snapshot; the history fold
 *   in wolfd/messages.ts follows the same rule). `textOffset` = length of the turn's merged assistant text so far (the
 *   history anchor); absent for a mid-turn joiner, who does not know it.
 * - An assistant message that ends with stopReason "error" yields an `error` event before turn-end(error).
 * - message_update changes of every kind (text_start/thinking_start/block/message as well as the deltas) update a
 *   per-block map; the aggregate is diffed against what has streamed: a suffix becomes a delta, anything else a
 *   correction (resync). A restreamed head therefore reaches the view instead of being dropped.
 * - If the final text/thinking at message_end is NOT an extension of what streamed (a provider retry diverged), no tail
 *   is emitted; a `{type:"resync", correction}` is surfaced instead. An empty final side is never treated as divergence.
 * - A mid-stream engine `snapshot` is surfaced as `{type:"resync"}`: the serving layer owns protocol snapshots.
 * - Everything else (usage, inbox, submission placement, agent_changed, user/system/tool-result messages...) is dropped.
 * - Steer lands after the current tool round (engine behaviour); nothing here assumes mid-tool delivery.
 */
import type { Actor, ThreadEvent } from "@wolfpack/protocol";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";
import { objectFromCall } from "./objects.js";

export type EngineEvent = AgentEvent;
export type EngineSnapshot = SnapshotEvent;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A protocol event before the serving layer stamps id/threadId/at/actor. */
export type ThreadEventDraft = DistributiveOmit<Exclude<ThreadEvent, { type: "snapshot" }>, "id" | "threadId" | "at" | "actor">;

/** The engine lost our place (overflow); the serving layer should send a protocol snapshot and keep mapping. */
export interface ResyncDraft {
  type: "resync";
  /** Engine overflow: re-base state on this snapshot. */
  snapshot?: EngineSnapshot;
  /**
   * Stream divergence (a provider retry regenerated different text): the deltas already emitted for the current
   * assistant message are stale. `stale*` is exactly what was streamed, `text`/`thinking` the authoritative final.
   * The serving layer rewrites its in-flight view and sends a protocol snapshot.
   */
  correction?: { turnId: string; text: string; thinking: string; staleText: string; staleThinking: string };
}

export type MappedEvent = ThreadEventDraft | ResyncDraft;

export interface StampContext {
  threadId: string;
  /** Next per-thread monotonic id, minted by the serving layer. */
  id: number;
  actor: Actor;
  at?: Date;
}

/** Stamp a draft into a full protocol event. */
export function stampEvent(draft: ThreadEventDraft, ctx: StampContext): ThreadEvent {
  return {
    ...draft,
    id: ctx.id,
    threadId: ctx.threadId,
    at: (ctx.at ?? new Date()).toISOString(),
    actor: ctx.actor,
  } as ThreadEvent;
}

export interface EventMapper {
  /** Map one engine batch (one commit's events). */
  push(events: readonly EngineEvent[]): MappedEvent[];
  /** End of stream: emit any deferred turn-end. */
  flush(): MappedEvent[];
}

type Reason = "complete" | "aborted" | "error";

interface MapperState {
  turnId?: string;
  /** Run ended; waiting for the submission that carries the reason. */
  ended?: { inputs: Set<number> };
  hint: Reason;
  text: string;
  thinking: string;
  /** The in-flight assistant message's text/thinking blocks by content index (tool-call blocks are not tracked). */
  blocks: Map<string, { kind: "text" | "thinking"; index: number; text: string }>;
  tools: Map<string, string>;
  /** Object-tool calls in flight: callId -> name + args. */
  objectCalls: Map<string, { name: string; args: unknown }>;
  /** Revs issued so far per objectId. */
  objectRevs: Map<string, number>;
  /** Length of the turn's merged assistant text (closed messages joined by a blank line); undefined when joined mid-turn. */
  turnTextLen: number | undefined;
}

interface TextBlock {
  type: "text";
  text: string;
}
interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

function blocksOf(message: unknown): { text: string; thinking: string } {
  const content = (message as { content?: unknown })?.content;
  let text = "";
  let thinking = "";
  if (Array.isArray(content)) {
    for (const b of content as Array<TextBlock | ThinkingBlock | { type: string }>) {
      if (b.type === "text") text += (b as TextBlock).text ?? "";
      else if (b.type === "thinking") thinking += (b as ThinkingBlock).thinking ?? "";
    }
  } else if (typeof content === "string") {
    text = content;
  }
  return { text, thinking };
}

function resultText(message: unknown): string {
  const content = (message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

const turnIdFor = (input: number | undefined) => `turn-${input ?? "unknown"}`;

/** Seed from an attach snapshot so a mid-run joiner's deltas map to the right turn. */
export function createEventMapper(seed?: EngineSnapshot): EventMapper {
  const s: MapperState = { hint: "complete", text: "", thinking: "", blocks: new Map(), tools: new Map(), objectCalls: new Map(), objectRevs: new Map(), turnTextLen: undefined };
  const debugStream = process.env.WOLFPACK_DEBUG_STREAM === "1";

  /** Re-seed the block map from a (partial) message's content. */
  const seedBlocks = (message: unknown) => {
    s.blocks = new Map();
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) {
      const { text } = blocksOf(message);
      if (text) s.blocks.set("text:0", { kind: "text", index: 0, text });
      return;
    }
    content.forEach((_, i) => setBlock(i, content[i]));
  };

  const aggregate = (kind: "text" | "thinking") =>
    [...s.blocks.values()]
      .filter((b) => b.kind === kind)
      .sort((a, b) => a.index - b.index)
      .map((b) => b.text)
      .join("");

  const setBlock = (index: number, block: unknown) => {
    const b = block as { type?: string; text?: string; thinking?: string } | undefined;
    s.blocks.delete(`text:${index}`);
    s.blocks.delete(`thinking:${index}`);
    if (b?.type === "text") s.blocks.set(`text:${index}`, { kind: "text", index, text: b.text ?? "" });
    else if (b?.type === "thinking") s.blocks.set(`thinking:${index}`, { kind: "thinking", index, text: b.thinking ?? "" });
  };

  /**
   * Bring one side (text or thinking) of the stream up to `next`. An extension is emitted as a suffix delta; anything
   * else is a divergence the caller reports as a correction. Returns what the side's stale value is for that correction
   * (the value now streamed when it extended, the old one when it diverged).
   */
  const advance = (kind: "text" | "thinking", next: string, out: MappedEvent[]): { diverged: boolean; stale: string } => {
    const streamed = s[kind];
    if (next.startsWith(streamed)) {
      if (next.length > streamed.length) out.push({ type: kind === "text" ? "text-delta" : "thinking-delta", turnId: s.turnId!, text: next.slice(streamed.length) });
      s[kind] = next;
      return { diverged: false, stale: next };
    }
    s[kind] = next;
    return { diverged: true, stale: streamed };
  };

  /** Emit the difference between what has streamed and the block map: a suffix delta per side that still extends, one correction for a side that diverged. */
  const syncStreamed = (out: MappedEvent[]) => {
    if (!s.turnId) return;
    const text = aggregate("text");
    const thinking = aggregate("thinking");
    const t = advance("text", text, out);
    const k = advance("thinking", thinking, out);
    if (t.diverged || k.diverged) {
      out.push({
        type: "resync",
        correction: { turnId: s.turnId, text, thinking, staleText: t.stale, staleThinking: k.stale },
      });
    }
  };

  /** Rev counters from calls whose result is already in the entries; calls still awaiting one end later. */
  const seedObjects = (snap: EngineSnapshot) => {
    s.objectCalls = new Map();
    s.objectRevs = new Map();
    const ok = new Set<string>(); // calls whose result landed without an error
    const done = new Set<string>();
    for (const e of snap.entries) {
      const m = e.model?.[0] as { toolCallId?: string; isError?: boolean } | undefined;
      if (!e.kind.startsWith("pi.tool") || !m?.toolCallId) continue;
      done.add(m.toolCallId);
      if (m.isError !== true) ok.add(m.toolCallId);
    }
    for (const e of snap.entries) {
      if (e.kind !== "pi.assistant") continue;
      const content = (e.model?.[0] as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content as Array<{ type: string; id?: string; name?: string; arguments?: unknown }>) {
        if (b.type !== "toolCall" || !b.id) continue;
        const o = objectFromCall(b.name, b.arguments);
        if (!o) continue;
        if (ok.has(b.id)) s.objectRevs.set(o.objectId, (s.objectRevs.get(o.objectId) ?? 0) + 1);
        else if (!done.has(b.id)) s.objectCalls.set(b.id, { name: b.name!, args: b.arguments });
      }
    }
  };

  // The block map is seeded alongside the flat text/thinking totals so a mid-run joiner's later block changes diff correctly.
  const seedFrom = (snap: EngineSnapshot) => {
    s.turnId = snap.run ? turnIdFor(Number(snap.run.inputs[0])) : undefined;
    s.ended = undefined;
    s.hint = "complete";
    const partial = blocksOf(snap.generation?.message);
    s.text = partial.text;
    s.thinking = partial.thinking;
    seedBlocks(snap.generation?.message);
    s.tools = new Map(snap.tools.filter((t) => t.status !== "done").map((t) => [t.callId, t.output ?? ""]));
    seedObjects(snap);
    s.turnTextLen = undefined;
  };
  if (seed) seedFrom(seed);

  const closeTurn = (out: MappedEvent[], reason: Reason) => {
    if (s.turnId) out.push({ type: "turn-end", turnId: s.turnId, reason });
    s.turnId = undefined;
    s.ended = undefined;
    s.hint = "complete";
  };

  /** Emit whatever part of `final` the stream has not shown yet. An empty final side is never a divergence. */
  const reconcile = (out: MappedEvent[], final: { text: string; thinking: string }) => {
    if (!s.turnId) return;
    const side = (kind: "text" | "thinking") => (final[kind] === "" ? { diverged: false, stale: s[kind] } : advance(kind, final[kind], out));
    const k = side("thinking");
    const t = side("text");
    if (t.diverged || k.diverged) {
      out.push({
        type: "resync",
        correction: {
          turnId: s.turnId,
          text: t.diverged ? final.text : s.text,
          thinking: k.diverged ? final.thinking : s.thinking,
          staleText: t.stale,
          staleThinking: k.stale,
        },
      });
    }
  };

  const handle = (e: EngineEvent, out: MappedEvent[]) => {
    switch (e.type) {
      case "snapshot":
        out.push({ type: "resync", snapshot: e });
        seedFrom(e);
        return;

      case "run_start":
        // A previous run still waiting for its submission is settled by the hint.
        if (s.ended) closeTurn(out, s.hint);
        s.turnId = turnIdFor(Number(e.inputs[0]));
        s.hint = "complete";
        s.turnTextLen = 0;
        out.push({ type: "turn-start", turnId: s.turnId });
        return;

      case "run_end":
        if (s.turnId) s.ended = { inputs: new Set(e.inputs.map(Number)) };
        return;

      case "submission": {
        const r = e.record;
        if (!s.ended || r.type !== "input" || !s.ended.inputs.has(Number(r.id))) return;
        if (r.status === "done") closeTurn(out, "complete");
        else if (r.status === "unanswered") closeTurn(out, r.reason === "aborted" ? "aborted" : "error");
        return;
      }

      case "message_start": {
        const m = e.message;
        if (m.role !== "assistant" || !s.turnId) return;
        const partial = blocksOf(m);
        if (partial.thinking) out.push({ type: "thinking-delta", turnId: s.turnId, text: partial.thinking });
        if (partial.text) out.push({ type: "text-delta", turnId: s.turnId, text: partial.text });
        s.text = partial.text;
        s.thinking = partial.thinking;
        seedBlocks(m);
        return;
      }

      case "message_update": {
        if (!s.turnId) return;
        if (debugStream) console.debug(`[wolfd stream] message_update changes=[${e.changes.map((c) => c.type).join(",")}]`);
        for (const c of e.changes) {
          switch (c.type) {
            case "text_start":
            case "thinking_start":
            case "block":
              setBlock(c.contentIndex, c.block);
              break;
            case "text_delta":
            case "thinking_delta": {
              const kind = c.type === "text_delta" ? "text" : "thinking";
              const b = s.blocks.get(`${kind}:${c.contentIndex}`);
              if (b) b.text += c.delta;
              else s.blocks.set(`${kind}:${c.contentIndex}`, { kind, index: c.contentIndex, text: c.delta });
              break;
            }
            case "message":
              seedBlocks(c.message);
              break;
            default:
              break; // toolcall_start / toolcall_delta: tool calls surface via tool_execution_*
          }
        }
        syncStreamed(out);
        return;
      }

      case "message_end": {
        if (e.entry.kind !== "pi.assistant" || !s.turnId) return;
        const msg = e.entry.model?.[0] as { stopReason?: string; errorMessage?: string } | undefined;
        const final = blocksOf(msg);
        reconcile(out, final);
        if (s.turnTextLen !== undefined && final.text !== "") s.turnTextLen += (s.turnTextLen === 0 ? 0 : 2) + final.text.length;
        s.text = "";
        s.thinking = "";
        s.blocks = new Map();
        if (msg?.stopReason === "aborted") s.hint = "aborted";
        else if (msg?.stopReason === "error") {
          s.hint = "error";
          out.push({ type: "error", turnId: s.turnId, message: msg.errorMessage ?? "model error" });
        }
        return;
      }

      case "tool_execution_start": {
        if (e.parentToolCallId || !s.turnId) return;
        s.tools.set(e.toolCallId, "");
        s.objectCalls.set(e.toolCallId, { name: e.toolName, args: e.args });
        out.push({ type: "tool-start", turnId: s.turnId, callId: e.toolCallId, name: e.toolName, args: e.args });
        return;
      }

      case "tool_execution_update": {
        if (e.parentToolCallId || !s.turnId || !e.output) return;
        const prev = s.tools.get(e.toolCallId) ?? "";
        const next =
          "set" in e.output ? e.output.set : prev.slice(e.output.trimStart ?? 0) + (e.output.append ?? "");
        s.tools.set(e.toolCallId, next);
        out.push({ type: "tool-update", turnId: s.turnId, callId: e.toolCallId, output: next });
        return;
      }

      case "tool_execution_end": {
        if (e.parentToolCallId || !s.turnId) return;
        const partial = s.tools.get(e.toolCallId) ?? "";
        s.tools.delete(e.toolCallId);
        const msg = e.entry?.model?.[0] as { isError?: boolean } | undefined;
        // The object first: the console places it by arrival, so it lands in the message of the call that shows it.
        const call = s.objectCalls.get(e.toolCallId);
        s.objectCalls.delete(e.toolCallId);
        const obj = msg && msg.isError !== true && call ? objectFromCall(call.name, call.args) : undefined;
        if (obj) {
          const rev = (s.objectRevs.get(obj.objectId) ?? 0) + 1;
          s.objectRevs.set(obj.objectId, rev);
          out.push({
            type: "object-upsert",
            turnId: s.turnId,
            objectId: obj.objectId,
            objectType: obj.type,
            rev,
            data: obj.data,
            ...(s.turnTextLen !== undefined ? { textOffset: s.turnTextLen } : {}),
          });
        }
        out.push({
          type: "tool-end",
          turnId: s.turnId,
          callId: e.toolCallId,
          result: msg ? resultText(msg) : partial || "Tool did not complete.",
          isError: msg ? msg.isError === true : true,
        });
        return;
      }

      default:
        return; // turn_start/turn_end, usage, inbox, entry_appended, agent_changed, ...
    }
  };

  return {
    push(events) {
      const out: MappedEvent[] = [];
      for (const e of events) handle(e, out);
      return out;
    },
    flush() {
      const out: MappedEvent[] = [];
      if (s.ended) closeTurn(out, s.hint);
      return out;
    },
  };
}

/**
 * Map a stream of engine event batches (what `watchEvents` delivers per commit) to protocol event drafts.
 * Pass the attach snapshot as `seed` when joining mid-run.
 */
export async function* mapEngineEvents(
  batches: AsyncIterable<readonly EngineEvent[]>,
  seed?: EngineSnapshot,
): AsyncGenerator<MappedEvent> {
  const mapper = createEventMapper(seed);
  for await (const batch of batches) yield* mapper.push(batch);
  yield* mapper.flush();
}
