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
          if (e?.type === "content_block_start" && e.content_block?.type === "tool_use") sawTool = true;
          if (e?.type === "message_delta" && e.delta?.stop_reason) sdkStop = e.delta.stop_reason;
          if (e?.type === "message_delta" && e.delta?.stop_reason === "tool_use") sawTool = true;
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
