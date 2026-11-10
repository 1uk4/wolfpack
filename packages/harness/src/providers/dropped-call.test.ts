import { describe, expect, it, vi } from "vitest";
import { roundNotes } from "./max-turns.js";
import { DROPPED_CALL_MESSAGE, withDroppedCallNet } from "./dropped-call.js";

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
});
