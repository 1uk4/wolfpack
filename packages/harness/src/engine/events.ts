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
 * - An assistant message that ends with stopReason "error" yields an `error` event before turn-end(error).
 * - If the final text/thinking at message_end is NOT an extension of what streamed (a provider retry diverged), no tail
 *   is emitted; a `{type:"resync", correction}` is surfaced instead. An empty final side is never treated as divergence.
 * - A mid-stream engine `snapshot` is surfaced as `{type:"resync"}`: the serving layer owns protocol snapshots.
 * - Everything else (usage, inbox, submission placement, agent_changed, user/system/tool-result messages...) is dropped.
 * - Steer lands after the current tool round (engine behaviour); nothing here assumes mid-tool delivery.
 */
import type { Actor, ThreadEvent } from "@wolfpack/protocol";
import type { AgentEvent, SnapshotEvent } from "@earendil-works/pi-durable";

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
  tools: Map<string, string>;
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
  const s: MapperState = { hint: "complete", text: "", thinking: "", tools: new Map() };

  const seedFrom = (snap: EngineSnapshot) => {
    s.turnId = snap.run ? turnIdFor(Number(snap.run.inputs[0])) : undefined;
    s.ended = undefined;
    s.hint = "complete";
    const partial = blocksOf(snap.generation?.message);
    s.text = partial.text;
    s.thinking = partial.thinking;
    s.tools = new Map(snap.tools.filter((t) => t.status !== "done").map((t) => [t.callId, t.output ?? ""]));
  };
  if (seed) seedFrom(seed);

  const closeTurn = (out: MappedEvent[], reason: Reason) => {
    if (s.turnId) out.push({ type: "turn-end", turnId: s.turnId, reason });
    s.turnId = undefined;
    s.ended = undefined;
    s.hint = "complete";
  };

  /** Emit whatever part of `final` the stream has not shown yet. */
  const reconcile = (out: MappedEvent[], final: { text: string; thinking: string }) => {
    if (!s.turnId) return;
    if (final.thinking.length > s.thinking.length && final.thinking.startsWith(s.thinking)) {
      out.push({ type: "thinking-delta", turnId: s.turnId, text: final.thinking.slice(s.thinking.length) });
    }
    if (final.text.length > s.text.length && final.text.startsWith(s.text)) {
      out.push({ type: "text-delta", turnId: s.turnId, text: final.text.slice(s.text.length) });
    }
    const diverged = (streamed: string, fin: string) => fin !== "" && fin !== streamed && !fin.startsWith(streamed);
    if (diverged(s.text, final.text) || diverged(s.thinking, final.thinking)) {
      out.push({
        type: "resync",
        correction: {
          turnId: s.turnId,
          text: final.text,
          thinking: final.thinking,
          staleText: s.text,
          staleThinking: s.thinking,
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
        return;
      }

      case "message_update": {
        if (!s.turnId) return;
        for (const c of e.changes) {
          if (c.type === "text_delta" && c.delta) {
            s.text += c.delta;
            out.push({ type: "text-delta", turnId: s.turnId, text: c.delta });
          } else if (c.type === "thinking_delta" && c.delta) {
            s.thinking += c.delta;
            out.push({ type: "thinking-delta", turnId: s.turnId, text: c.delta });
          }
        }
        return;
      }

      case "message_end": {
        if (e.entry.kind !== "pi.assistant" || !s.turnId) return;
        const msg = e.entry.model?.[0] as { stopReason?: string; errorMessage?: string } | undefined;
        reconcile(out, blocksOf(msg));
        s.text = "";
        s.thinking = "";
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
