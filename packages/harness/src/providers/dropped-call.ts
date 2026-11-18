import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { roundNotes, type RoundSlot } from "./max-turns.js";

export const DROPPED_CALL_MESSAGE = "The model's tool call was lost (bridge dropped it); please resend";
export const EMPTY_ACK_MESSAGE = "The model answered with an empty acknowledgement (\"No response requested\") twice; please resend";
/**
 * Sent after every tool-result round, replacing the bridge default "[Continue from the tool result above.]"
 * (pi-claude-bridge-stateless src/stateless/plan.ts:11), which the model read as "nothing asked of me" after
 * acknowledgement-only results (launched, resumed, saved) and answered "No response requested." Passed to the bridge as
 * its `continuePrompt` option; also the user text of an empty-ack retry.
 */
export const CONTINUE_PROMPT = "If more work remains, call the next tool. Otherwise write your closing message to the owner: what you did and what is pending. Never reply with 'No response requested' or an empty acknowledgement.";
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
 *
 * Empty ack: after a round of tool results the model sometimes ends the turn with only "No response requested."
 * (stopReason stop, no toolCall). Only when the last context message is a toolResult (never a user prompt) such a message
 * is treated like a drop: one retry, then EMPTY_ACK_MESSAGE. Text deltas that are still a prefix of the phrase are held
 * until the text turns into something else, so the phrase never reaches the user.
 */
const ACK = "no response requested.";
const ACK_RE = /^\s*no response requested\.?\s*$/i;
const isEmptyAck = (msg: any) => {
  const c = msg?.content ?? [];
  const texts = c.filter((b: any) => b?.type === "text");
  return msg?.stopReason === "stop" && !c.some((b: any) => b?.type === "toolCall")
    && texts.length > 0 && ACK_RE.test(texts.map((b: any) => String(b.text ?? "")).join(""));
};
const stillAckPrefix = (text: string) => ACK.startsWith(text.trim().toLowerCase());
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
      let ctx = context; // an empty-ack retry gets CONTINUE_PROMPT as an explicit user message: the same prompt would likely repeat the ack
      for (let attempt = 1; attempt <= 2; attempt++) {
        const slot: RoundSlot = {};
        const inner = roundNotes.run(slot, () => stream(model, ctx, options));
        let held: any[] | undefined = [];
        let committed = false; // visible text or a tool call was released
        const release = () => { const h = held; held = undefined; h?.forEach((e) => out.push(e)); };
        let retry = false;
        const ackCtx = (context?.messages ?? []).at(-1)?.role === "toolResult";
        const retryCtx = () => ({ ...context, messages: [...(context?.messages ?? []), { role: "user", content: CONTINUE_PROMPT, timestamp: Date.now() }] });
        let textAcc = "";
        for await (const e of inner as AsyncIterable<any>) {
          if (e.type === "done") {
            const ack = ackCtx && !committed && isEmptyAck(e.message);
            if (!committed && (ack || isDropped(slot, e.message))) {
              log(ack ? `claude-stateless: EMPTY ACK (attempt ${attempt})` : `claude-stateless: DROPPED TOOL CALL (attempt ${attempt}): ${slot.rewrite}`);
              lastMsg = e.message;
              if (options?.signal?.aborted) {
                out.push({ type: "error", reason: "aborted", error: { ...addUsage(e.message, carried), content: [], stopReason: "aborted", errorMessage: "aborted" } });
                out.end();
                return;
              }
              if (attempt === 1 && !thinkingShown) { carried = addUsage({ usage: carried ?? zeroUsage() }, e.message.usage).usage; retry = true; if (ack) ctx = retryCtx(); break; }
              out.push({ type: "error", reason: "error", error: { ...addUsage(e.message, carried), content: [], stopReason: "error", errorMessage: ack ? EMPTY_ACK_MESSAGE : DROPPED_CALL_MESSAGE } });
              out.end();
              return;
            }
            if (e.message?.stopReason === "stop" && !(e.message.content ?? []).some((b: any) => b?.type === "toolCall")) {
              // Tells an empty ack apart from a real answer in the log (length and a flag only: no reply text in the log).
              const t = (e.message.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => String(b.text ?? "")).join("");
              log(`claude-stateless: END TURN text length=${t.length} emptyAck=${ACK_RE.test(t)}`);
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
          if (e.type === "text_start") textAcc = "";
          if (e.type === "text_delta") textAcc += String(e.delta ?? "");
          if (held && (e.type === "toolcall_start"
            || (e.type === "text_delta" && textAcc.trim() !== "" && !(ackCtx && stillAckPrefix(textAcc)))
            || (e.type === "text_end" && ackCtx && textAcc.trim() !== "" && !ACK_RE.test(textAcc)))) { committed = true; release(); }
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
