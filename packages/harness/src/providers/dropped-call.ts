import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { roundNotes, type RoundSlot } from "./max-turns.js";

/**
 * Round-end check for a call the bridge dropped (work-wolfpack-7g4ZFMJ). withMaxTurnsAsTurnEnd records a summary in the
 * round slot whenever it rewrites error_max_turns; every ordinary tool round does too. A DROP is a rewritten round whose
 * final pi message has no toolCall. This wrapper runs one bridge round inside a slot, relays its events unchanged, and at
 * the end logs that summary once for a drop. A round without a rewrite is never touched.
 */
export const isDropped = (slot: RoundSlot, msg: any) =>
  slot.rewrite !== undefined && msg?.stopReason === "stop" && !(msg.content ?? []).some((b: any) => b?.type === "toolCall");

export const withDroppedCallNet = (streamSimple: (...a: any[]) => any, log: (line: string) => void = (l) => console.warn(l)) =>
  (model: any, context: any, options?: any) => {
    const slot: RoundSlot = {};
    const inner = roundNotes.run(slot, () => streamSimple(model, context, options));
    const out = createAssistantMessageEventStream();
    void (async () => {
      for await (const e of inner as AsyncIterable<any>) {
        if (e.type === "done" && isDropped(slot, e.message)) log(`claude-stateless: DROPPED TOOL CALL: ${slot.rewrite}`);
        out.push(e);
      }
      out.end();
    })().catch((err) => {
      out.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: String(err?.message ?? err) } } as never);
      out.end();
    });
    return out;
  };
