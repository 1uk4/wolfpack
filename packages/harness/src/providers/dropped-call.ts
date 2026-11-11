import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { roundNotes, type RoundSlot } from "./max-turns.js";

export const DROPPED_CALL_MESSAGE = "The model's tool call was lost (bridge dropped it); please resend";
export const NO_TERMINAL_MESSAGE = "The model stream ended without a result";

/**
 * Net for a call the bridge dropped (work-wolfpack-7g4ZFMJ). withMaxTurnsAsTurnEnd records a summary in the round slot
 * whenever it rewrites error_max_turns; every ordinary tool round does too. A DROP is a rewritten round whose final pi
 * message has stopReason stop, no toolCall and no visible text. A round without a rewrite is never touched (a legitimate
 * empty end of turn stays as it is). A rewritten round with real text plus a dropped call is NOT a drop here: the user
 * has the text, the turn ends normally, and it is not retried.
 *
 * Why here (the provider stream) and not wolfd's thread.ts: only here do we know the rewrite happened (the slot), a retry
 * is a clean second bridge round before pi has seen anything, and subagents and every other caller of the provider get
 * the net too. thread.ts sees only the finished message and could not tell a drop from a real empty answer.
 *
 * What is held and what streams: `start` and `thinking_*` events stream live (thinking must not arrive in one burst after
 * it finishes). Everything else (text_*, toolcall_*) is held until the round shows visible text or a tool call, then
 * released and streamed live. A drop has neither, so only held events would have to be taken back.
 *
 * Retry: once, on a drop, only while nothing but `start` was emitted. A retry cannot continue cleanly after thinking was
 * shown: the bridge numbers content blocks from 0 per round and pi builds one message from the stream's partials, so the
 * retry's thinking would duplicate what the user saw and its indices would collide with the first round's. So when
 * thinking was already emitted, a drop ends the stream with the visible DROPPED_CALL_MESSAGE error, no retry. The retry's
 * own `start` is skipped (the consumer already has one). A second drop ends with the same error. An aborted signal is never
 * retried: the stream ends with the aborted error. A stream that ends with neither done nor error gets an error event (no
 * retry: the outcome is unknown and a retry is paid for). The dropped attempt's usage is added to the final message.
 */
const isDropped = (slot: RoundSlot, msg: any) =>
  slot.rewrite !== undefined && msg?.stopReason === "stop"
  && !(msg.content ?? []).some((b: any) => b?.type === "toolCall" || (b?.type === "text" && String(b.text ?? "").trim() !== ""));

const NUM = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const;
const COST = ["input", "output", "cacheRead", "cacheWrite", "total"] as const;
const addUsage = (msg: any, extra: any) => {
  if (!extra || !msg?.usage) return msg;
  const u = msg.usage;
  const sum: any = { ...u, cost: { ...(u.cost ?? {}) } };
  for (const k of NUM) sum[k] = (u[k] ?? 0) + (extra[k] ?? 0);
  for (const k of COST) sum.cost[k] = (u.cost?.[k] ?? 0) + (extra.cost?.[k] ?? 0);
  return { ...msg, usage: sum };
};

export const withDroppedCallNet = (stream: (...a: any[]) => any, log: (line: string) => void = (l) => console.warn(l)) =>
  (model: any, context: any, options?: any) => {
    const out = createAssistantMessageEventStream();
    void (async () => {
      let carried: any; // usage of dropped attempts
      let lastMsg: any;
      let started = false;
      let thinkingShown = false;
      for (let attempt = 1; attempt <= 2; attempt++) {
        const slot: RoundSlot = {};
        const inner = roundNotes.run(slot, () => stream(model, context, options));
        let held: any[] | undefined = [];
        let committed = false; // visible text or a tool call was released
        const release = () => { const h = held; held = undefined; h?.forEach((e) => out.push(e)); };
        let retry = false;
        for await (const e of inner as AsyncIterable<any>) {
          if (e.type === "done") {
            if (!committed && isDropped(slot, e.message)) {
              log(`claude-stateless: DROPPED TOOL CALL (attempt ${attempt}): ${slot.rewrite}`);
              lastMsg = e.message;
              if (options?.signal?.aborted) {
                out.push({ type: "error", reason: "aborted", error: { ...addUsage(e.message, carried), content: [], stopReason: "aborted", errorMessage: "aborted" } });
                out.end();
                return;
              }
              if (attempt === 1 && !thinkingShown) { carried = addUsage({ usage: carried ?? zeroUsage() }, e.message.usage).usage; retry = true; break; }
              out.push({ type: "error", reason: "error", error: { ...addUsage(e.message, carried), content: [], stopReason: "error", errorMessage: DROPPED_CALL_MESSAGE } });
              out.end();
              return;
            }
            release();
            out.push({ ...e, message: addUsage(e.message, carried) });
            out.end();
            return;
          }
          if (e.type === "error") { release(); out.push(e); out.end(); return; }
          if (e.type === "start") { if (!started) { started = true; out.push(e); } continue; }
          if (e.type.startsWith("thinking_")) { release(); thinkingShown = true; out.push(e); continue; }
          if (held) held.push(e); else out.push(e);
          if (held && (e.type === "toolcall_start" || (e.type === "text_delta" && String(e.delta ?? "").trim() !== ""))) { committed = true; release(); }
        }
        if (!retry) break; // the inner stream ended without done or error
      }
      out.push({ type: "error", reason: "error", error: { ...addUsage(lastMsg ?? { role: "assistant", usage: zeroUsage() }, undefined), content: [], stopReason: "error", errorMessage: NO_TERMINAL_MESSAGE } });
      out.end();
    })().catch((err) => {
      out.push({ type: "error", reason: "error", error: { role: "assistant", content: [], stopReason: "error", errorMessage: String(err?.message ?? err) } } as never);
      out.end();
    });
    return out;
  };

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
