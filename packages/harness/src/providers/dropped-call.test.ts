import { describe, expect, it, vi } from "vitest";
import { roundNotes } from "./max-turns.js";
import { DROPPED_CALL_MESSAGE, EMPTY_ACK_MESSAGE, EMPTY_ACK_NUDGE, withDroppedCallNet } from "./dropped-call.js";
import { subAgentHead } from "../injected-text.js";
import { supersededNotes } from "../superseded-note.js";
import { answerText } from "../wolfd/cards.js";
import { describeChange } from "../wolfd/task-notice.js";

const usage = (n: number) => ({ input: n, output: n, cacheRead: n, cacheWrite: n, totalTokens: 4 * n, cost: { input: n, output: n, cacheRead: n, cacheWrite: n, total: 4 * n } });
const msg = (content: any[], u = usage(1), stopReason = "stop") => ({ role: "assistant", content, stopReason, usage: u });
const done = (m: any) => ({ type: "done", reason: m.stopReason, message: m });
// A fake inner round: runs inside the round slot like the real one; `rewrite` marks a max-turns rewrite.
const round = (events: any[], rewrite?: string) => () => {
  const slot = roundNotes.getStore();
  if (slot && rewrite) slot.rewrite = rewrite;
  return (async function* () { yield* events; })();
};
const rounds = (...r: Array<(...a: any[]) => any>) => { let i = 0; return vi.fn((...a: any[]) => r[Math.min(i++, r.length - 1)](...a)); };
const collect = async (s: any) => { const o: any[] = []; for await (const e of s) o.push(e); return o; };
const dropped = (u = usage(1), extra: any[] = []) => round([{ type: "start" }, ...extra, done(msg([], u))], "blocks=[tool_use]");
const toolDone = round([{ type: "start" }, done(msg([{ type: "toolCall", id: "t", name: "add", arguments: {} }], usage(2), "toolUse"))]);

describe("withDroppedCallNet (work-wolfpack-7g4ZFMJ)", () => {
  it("ends with one error event when the inner stream ends without done or error, and does not retry", async () => {
    const q = rounds(round([{ type: "start" }], "blocks=[tool_use]"));
    const events = await collect(withDroppedCallNet(q, vi.fn())({}, {}, {}));
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.at(-1).error.stopReason).toBe("error");
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("streams thinking live: a thinking delta reaches the consumer before the round's done", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = () => (async function* () {
      yield { type: "start" };
      yield { type: "thinking_start", contentIndex: 0 };
      yield { type: "thinking_delta", contentIndex: 0, delta: "hmm" };
      await gate;
      yield done(msg([{ type: "text", text: "hi" }]));
    })();
    const iter = withDroppedCallNet(slow, vi.fn())({}, {}, {})[Symbol.asyncIterator]();
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) seen.push((await iter.next()).value.type);
    expect(seen).toEqual(["start", "thinking_start", "thinking_delta"]);
    release();
  });

  it("does not retry a dropped round once thinking was shown; it ends with the visible error", async () => {
    const q = rounds(dropped(usage(1), [{ type: "thinking_start", contentIndex: 0 }]), toolDone);
    const events = await collect(withDroppedCallNet(q, vi.fn())({}, {}, {}));
    expect(events.at(-1)).toMatchObject({ type: "error", error: { stopReason: "error", errorMessage: DROPPED_CALL_MESSAGE } });
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("retries silently when nothing visible was emitted, with one start and the dropped attempt's usage added", async () => {
    const events = await collect(withDroppedCallNet(rounds(dropped(usage(1)), toolDone), vi.fn())({}, {}, {}));
    expect(events.filter((e) => e.type === "start")).toHaveLength(1);
    const final = events.at(-1);
    expect(final.type).toBe("done");
    expect(final.message.usage).toEqual(usage(3));
  });

  it("does not retry after the signal is aborted; it ends with the aborted error", async () => {
    const ac = new AbortController();
    const q = rounds(() => { ac.abort(); return dropped()(); }, toolDone);
    const events = await collect(withDroppedCallNet(q, vi.fn())({}, {}, { signal: ac.signal }));
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted", error: { stopReason: "aborted", errorMessage: "aborted" } });
    expect(q).toHaveBeenCalledTimes(1);
  });

  describe("empty acknowledgement after tool results", () => {
    const toolCtx = { messages: [{ role: "user", content: "go" }, { role: "toolResult", toolName: "agent", content: [{ type: "text", text: "launched" }] }] };
    const userCtx = { messages: [{ role: "user", content: "hi" }] };
    const textRound = (text: string, deltas: string[] = [text], u = usage(1)) => () =>
      (async function* () {
        yield { type: "start" };
        yield { type: "text_start", contentIndex: 0 };
        for (const d of deltas) yield { type: "text_delta", contentIndex: 0, delta: d };
        yield { type: "text_end", contentIndex: 0 };
        yield done(msg([{ type: "text", text }], u));
      })();
    const real = textRound("Started the worker; expect a report in a few minutes.");

    it("retries a tool_results empty ack once with the continue prompt, returns the retry's output, and never streams the phrase", async () => {
      const q = rounds(textRound("No response requested.", ["No resp", "onse requested."]), real);
      const log = vi.fn();
      const events = await collect(withDroppedCallNet(q, log)({}, toolCtx, {}));
      expect(q).toHaveBeenCalledTimes(2);
      const retried = q.mock.calls[1][1].messages;
      expect(retried).toHaveLength(2); // no standalone user turn added
      expect(retried.at(-1)).toMatchObject({ role: "toolResult", content: [{ type: "text", text: "launched" }, { type: "text", text: EMPTY_ACK_NUDGE }] });
      expect(EMPTY_ACK_NUDGE).not.toContain("If more work remains"); // not the bridge's continue prompt the model already ignored
      expect(events.at(-1).message.content[0].text).toBe("Started the worker; expect a report in a few minutes.");
      expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("")).not.toMatch(/no response/i);
      expect(events.at(-1).message.usage).toEqual(usage(2));
      expect(log).toHaveBeenCalledWith("claude-stateless: EMPTY ACK (attempt 1)");
    });

    it("ends with a visible error when the retry is an empty ack too", async () => {
      const q = rounds(textRound("No response requested."));
      const events = await collect(withDroppedCallNet(q, vi.fn())({}, toolCtx, {}));
      expect(q).toHaveBeenCalledTimes(2);
      expect(events.at(-1)).toMatchObject({ type: "error", error: { stopReason: "error", errorMessage: EMPTY_ACK_MESSAGE } });
    });

    it("does not retry an empty ack on a user prompt", async () => {
      const q = rounds(textRound("No response requested."));
      const events = await collect(withDroppedCallNet(q, vi.fn())({}, userCtx, {}));
      expect(q).toHaveBeenCalledTimes(1);
      expect(events.at(-1).type).toBe("done");
    });

    it("retries an empty ack once when the turn began with wolfd-injected user text (ask result, superseded note, task notice, sub-agent delivery)", async () => {
      // The real producers' output, not hand-copied strings.
      const card = { tool: "ask", fields: [{ id: "a", kind: "free-text" as const, label: "A" }] };
      const snap = { workId: "w", stage: "a", record: "r" };
      const injected = [
        answerText([{ callId: "c1", card, answers: {}, skipped: true }]),
        answerText([{ callId: "c1", card, answers: { a: { value: "x" } } }]),
        answerText([{ callId: "c1", card: { ...card, paged: true }, answers: { a: { value: "x" } } }]),
        `${supersededNotes([{ callId: "c1", tool: "ask" }])}actually do X`,
        `${describeChange(snap, { ...snap, stage: "b" })}\n\nhello`,
        `${subAgentHead("scout", "completed")}2m 1s).\n\nfound it`,
        `${subAgentHead("scout", "failed")}2m 1s: boom`,
        `${subAgentHead("scout", "merge")}merged`,
      ];
      for (const text of injected) {
        const q = rounds(textRound("No response requested."), real);
        const events = await collect(withDroppedCallNet(q, vi.fn())({}, { messages: [{ role: "user", content: text }] }, {}));
        expect(q, text).toHaveBeenCalledTimes(2);
        expect(events.at(-1).message.content[0].text).toBe("Started the worker; expect a report in a few minutes.");
      }
    });

    it("does not retry an ack to an owner message that only looks like wolfd text (merge:, Task update:, quoted mid-text)", async () => {
      for (const text of ["merge: x", "Task update: ship it", 'please explain: Sub-agent "a" completed (1s)', "the user skipped your question"]) {
        const q = rounds(textRound("No response requested."));
        const events = await collect(withDroppedCallNet(q, vi.fn())({}, { messages: [{ role: "user", content: text }] }, {}));
        expect(q, text).toHaveBeenCalledTimes(1);
        expect(events.at(-1).type, text).toBe("done");
      }
    });

    it("still retries, then ends with the visible error, when dropping the session file rejects", async () => {
      const forget = vi.fn(async () => { throw new Error("disk gone"); });
      const q = rounds(textRound("No response requested."), real);
      const log = vi.fn();
      const events = await collect(withDroppedCallNet(q, log, forget)({}, toolCtx, { sessionId: "s1" }));
      expect(q).toHaveBeenCalledTimes(2);
      expect(events.at(-1).message.content[0].text).toBe("Started the worker; expect a report in a few minutes.");
      expect(log).toHaveBeenCalledWith("claude-stateless: could not drop the session after an empty ack: disk gone");
      const q2 = rounds(textRound("No response requested."));
      const e2 = await collect(withDroppedCallNet(q2, vi.fn(), forget)({}, toolCtx, { sessionId: "s1" }));
      expect(e2.at(-1)).toMatchObject({ type: "error", error: { errorMessage: EMPTY_ACK_MESSAGE } });
      expect(EMPTY_ACK_MESSAGE).toContain("twice");
    });

    it("never puts the dropped ack into the retry's context", async () => {
      const q = rounds(textRound("No response requested."), real);
      await collect(withDroppedCallNet(q, vi.fn())({}, toolCtx, {}));
      const retryCtx = q.mock.calls[1][1];
      expect(retryCtx.messages.filter((m: any) => m.role === "assistant")).toEqual([]);
      expect(toolCtx.messages).toHaveLength(2);
    });

    it("drops the bridge's session file for the session when an ack is caught, before the retry runs and when the retry fails too", async () => {
      // Claude Code writes the ack itself as a <synthetic> record the bridge's verify skips, so a resumed file would replay it.
      const order: string[] = [];
      const forget = vi.fn(async (sid: string) => { order.push(`forget ${sid}`); });
      const q = vi.fn(() => { order.push("round"); return textRound("No response requested.")(); });
      await collect(withDroppedCallNet(q, vi.fn(), forget)({}, toolCtx, { sessionId: "s1" }));
      expect(order).toEqual(["round", "forget s1", "round", "forget s1"]);
    });

    it("after thinking was shown, an empty ack ends with the visible error (no duplicate blocks) and is logged", async () => {
      const thinkAck = () => (async function* () {
        yield { type: "start" };
        yield { type: "thinking_start", contentIndex: 0 };
        yield { type: "thinking_end", contentIndex: 0 };
        yield { type: "text_start", contentIndex: 1 };
        yield { type: "text_delta", contentIndex: 1, delta: "No response requested." };
        yield { type: "text_end", contentIndex: 1 };
        yield done(msg([{ type: "thinking", thinking: "hm" }, { type: "text", text: "No response requested." }]));
      })();
      const q = rounds(thinkAck, real);
      const log = vi.fn();
      const events = await collect(withDroppedCallNet(q, log)({}, toolCtx, {}));
      expect(q).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "error", error: { errorMessage: EMPTY_ACK_MESSAGE } });
      expect(log).toHaveBeenCalledWith("claude-stateless: EMPTY ACK (attempt 1)");
    });

    it("streams a longer real reply that contains the phrase without retrying", async () => {
      const text = "No response requested was the old bug; fixed now.";
      const q = rounds(textRound(text, ["No response ", "requested was the old bug; ", "fixed now."]));
      const events = await collect(withDroppedCallNet(q, vi.fn())({}, toolCtx, {}));
      expect(q).toHaveBeenCalledTimes(1);
      expect(events.filter((e) => e.type === "text_delta").map((e) => e.delta).join("")).toBe(text);
    });

    it("logs only the length and an emptyAck flag for an end_turn text, never the text", async () => {
      const log = vi.fn();
      await collect(withDroppedCallNet(rounds(real), log)({}, userCtx, {}));
      await collect(withDroppedCallNet(rounds(textRound("No response requested.")), log)({}, userCtx, {}));
      expect(log.mock.calls.map((c) => c[0])).toEqual([
        "claude-stateless: END TURN text length=53 emptyAck=false",
        "claude-stateless: END TURN text length=22 emptyAck=true",
      ]);
    });
  });
});
