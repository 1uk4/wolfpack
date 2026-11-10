import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-round side channel (work-wolfpack-7g4ZFMJ). withDroppedCallNet runs a bridge round inside `roundNotes.run(slot, ...)`;
 * the wrapper below writes a compact, value-free summary of the SDK's final assistant message into `slot.rewrite` when it
 * rewrites, so the round end can log it once the outcome (tool call or not) is known.
 */
export interface RoundSlot { rewrite?: string }
export const roundNotes = new AsyncLocalStorage<RoundSlot>();

interface SeenBlock { type: string; id?: string; name?: string; json: string; input?: Record<string, unknown> }
const summarize = (blocks: SeenBlock[], stop: string | undefined) => {
  const tools = blocks.filter((b) => b.type === "tool_use");
  const keys = (b: SeenBlock) => {
    if (b.input) return Object.keys(b.input);
    try { const v = b.json ? JSON.parse(b.json) : {}; return v && typeof v === "object" ? Object.keys(v) : []; } catch { return ["<unparseable>"]; }
  };
  const count = (t: string) => blocks.filter((b) => b.type === t).length;
  return `blocks=[${blocks.map((b) => b.type).join(",")}] tools=[${tools.map((b) => `${b.name}#${b.id}(${keys(b).join(",")})`).join(", ")}] multiTool=${tools.length > 1} thinking=${count("thinking")} redacted=${count("redacted_thinking")} stop_reason=${stop ?? "unknown"}`;
};

/**
 * `maxTurns: 1` (set by the bridge) means: one model message, and pi, not the SDK, executes tools. When that message ends
 * in a tool_use the SDK denies the call (PreToolUse hook), wants a second turn, and reports `result.subtype ===
 * "error_max_turns"` ("Reached maximum number of turns (1)"). That is a NORMAL turn end for a tool round. The bridge
 * tolerates it only when it announced a tool call itself (`sawToolUse`); when it did not (a call it dropped; an unserved tool name is not
 * one since bridge PR #2: it is passed to pi, which answers "Tool X not found"), the round died with the fatal error and the worker had to be resumed by hand
 * (work-wolfpack-beKfWkW; 11 of ~7.5k rounds in the soak log, all `sdkStopReason: tool_use`, all `tool_results` rounds).
 * This wrapper rewrites such a result (the stream saw a tool_use / stop_reason tool_use) to a plain success, so the bridge
 * ends the round normally and hands tool calls to the harness. The limit is NOT raised: the SDK never gets a second turn
 * and never executes anything. A max-turns result with no tool_use stays an error.
 *
 * Only valid with `maxTurns: 1`: the state below is per MESSAGE (reset on message_start), which is per query only when the SDK
 * never starts a second turn. With a larger limit a tool_use of turn 1 must not excuse a max-turns error after turn 2.
 *
 * Bridge: `pi-claude-bridge-stateless/stateless` (dist/stateless/provider.js consume()), which is what claude-stateless
 * imports. It is NOT the retired `pi-claude-bridge` (durable-core) package, which has no error_max_turns handling. Verified by max-turns.bridge.test.ts: the rewritten
 * `success` result ends a dropped-call round (tool_use only in a same-id `assistant` message) as done/stop (the call itself is lost; the log line says so).
 *
 * CHECK ON BRIDGE UPGRADE: the bridge only uses the async iterator and close() (like lazySdkQuery); interrupt(),
 * setModel() and the other Query methods are not forwarded. Re-check if a bridge version calls them.
 * Also re-check that the bridge still runs the query synchronously inside stream()/streamSimple(), so the AsyncLocalStorage
 * round slot reaches this wrapper; if it stops, the dropped-call net goes inactive (logged once: "no round slot").
 */
export const withMaxTurnsAsTurnEnd = (queryFn: (args: any) => any, log: (line: string) => void = (l) => console.warn(l)) => {
  let warnedNoSlot = false;
  return (args: any) => {
  const q = queryFn(args);
  let sawTool = false;
  let sdkStop: string | undefined;
  let blocks: SeenBlock[] = [];
  const byIndex = new Map<number, SeenBlock>();
  return {
    async *[Symbol.asyncIterator]() {
      for await (const m of q as AsyncIterable<any>) {
        if (m?.type === "stream_event" && !m.parent_tool_use_id) {
          const e = m.event;
          if (e?.type === "message_start") { sawTool = false; sdkStop = undefined; blocks = []; byIndex.clear(); }
          else if (e?.type === "content_block_start") {
            const cb = e.content_block ?? {};
            const b: SeenBlock = { type: String(cb.type ?? "unknown"), id: cb.id, name: cb.name, json: "" };
            blocks.push(b); byIndex.set(e.index, b);
            if (cb.type === "tool_use") sawTool = true;
          } else if (e?.type === "content_block_delta" && e.delta?.type === "input_json_delta") { const b = byIndex.get(e.index); if (b) b.json += e.delta.partial_json ?? ""; }
          else if (e?.type === "message_delta" && e.delta?.stop_reason) { sdkStop = e.delta.stop_reason; if (sdkStop === "tool_use") sawTool = true; }
        } else if (m?.type === "assistant" && !m.parent_tool_use_id) {
          if (blocks.length === 0 && Array.isArray(m.message?.content)) blocks = m.message.content.map((b: any) => ({ type: String(b?.type ?? "unknown"), id: b?.id, name: b?.name, json: "", input: b?.input && typeof b.input === "object" ? b.input : undefined }));
          if (!sdkStop && m.message?.stop_reason) sdkStop = m.message.stop_reason;
          if (m.message?.stop_reason === "tool_use" || (Array.isArray(m.message?.content) && m.message.content.some((b: any) => b?.type === "tool_use"))) sawTool = true;
        } else if (m?.type === "result" && m.subtype === "error_max_turns" && sawTool) {
          log(`claude-stateless: rewrote error_max_turns to a normal turn end (sdkStopReason=${sdkStop ?? m.stop_reason ?? "unknown"}); if the round then ends with stopReason=stop and no tool call, the bridge dropped the tool_use`);
          const slot = roundNotes.getStore();
          if (slot) slot.rewrite = summarize(blocks, sdkStop ?? m.stop_reason);
          else if (!warnedNoSlot) { warnedNoSlot = true; log("claude-stateless: dropped-call net inactive: no round slot"); }
          const { errors: _errors, ...rest } = m;
          yield { ...rest, subtype: "success", is_error: false, result: typeof m.result === "string" ? m.result : "" };
          continue;
        }
        yield m;
      }
    },
    close: () => q?.close?.(),
  };
};
};
