/**
 * `maxTurns: 1` (set by the bridge) means: one model message, and pi, not the SDK, executes tools. When that message ends
 * in a tool_use the SDK denies the call (PreToolUse hook), wants a second turn, and reports `result.subtype ===
 * "error_max_turns"` ("Reached maximum number of turns (1)"). That is a NORMAL turn end for a tool round. The bridge
 * tolerates it only when it announced a tool call itself (`sawToolUse`); when it did not (a tool_use it could not map to a
 * served pi tool, a call it dropped), the round died with the fatal error and the worker had to be resumed by hand
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
 * `success` result ends an unmapped-tool round as done/stop (the call itself is lost; the log line says so).
 *
 * CHECK ON BRIDGE UPGRADE: the bridge only uses the async iterator and close() (like lazySdkQuery); interrupt(),
 * setModel() and the other Query methods are not forwarded. Re-check if a bridge version calls them.
 */
export const withMaxTurnsAsTurnEnd = (queryFn: (args: any) => any, log: (line: string) => void = (l) => console.warn(l)) => (args: any) => {
  const q = queryFn(args);
  let sawTool = false;
  let sdkStop: string | undefined;
  return {
    async *[Symbol.asyncIterator]() {
      for await (const m of q as AsyncIterable<any>) {
        if (m?.type === "stream_event" && !m.parent_tool_use_id) {
          const e = m.event;
          if (e?.type === "message_start") { sawTool = false; sdkStop = undefined; }
          else if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") sawTool = true;
          else if (e?.type === "message_delta" && e.delta?.stop_reason) { sdkStop = e.delta.stop_reason; if (sdkStop === "tool_use") sawTool = true; }
        } else if (m?.type === "assistant" && !m.parent_tool_use_id) {
          if (m.message?.stop_reason === "tool_use" || (Array.isArray(m.message?.content) && m.message.content.some((b: any) => b?.type === "tool_use"))) sawTool = true;
        } else if (m?.type === "result" && m.subtype === "error_max_turns" && sawTool) {
          log(`claude-stateless: rewrote error_max_turns to a normal turn end (sdkStopReason=${sdkStop ?? m.stop_reason ?? "unknown"}); if the round then ends with stopReason=stop and no tool call, the bridge dropped the tool_use`);
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
