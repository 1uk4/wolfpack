import { describe, expect, it, vi } from "vitest";
import { withMaxTurnsAsTurnEnd } from "./max-turns.js";

describe("withMaxTurnsAsTurnEnd (work-wolfpack-beKfWkW)", () => {
  const fake = (msgs: any[]) => () => ({ async *[Symbol.asyncIterator]() { yield* msgs; }, close: vi.fn() });
  const collect = async (q: any) => { const out: any[] = []; for await (const m of q) out.push(m); return out; };
  const toolStart = { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "mcp__custom-tools__bash" } } };
  const maxTurns = { type: "result", subtype: "error_max_turns", is_error: true, errors: ["Reached maximum number of turns (1)"] };

  it("turns error_max_turns after a tool_use into a normal success result", async () => {
    const out = await collect(withMaxTurnsAsTurnEnd(fake([toolStart, maxTurns]))({}));
    const r = out.at(-1);
    expect(r).toMatchObject({ type: "result", subtype: "success", is_error: false });
    expect(r.errors).toBeUndefined();
  });
  it("logs one line with the sdkStopReason when it rewrites", async () => {
    const log = vi.fn();
    await collect(withMaxTurnsAsTurnEnd(fake([toolStart, { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } }, maxTurns]), log)({}));
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toContain("sdkStopReason=tool_use");
    const quiet = vi.fn();
    await collect(withMaxTurnsAsTurnEnd(fake([maxTurns]), quiet)({}));
    expect(quiet).not.toHaveBeenCalled();
  });
  it("also recognises stop_reason tool_use and assistant tool_use blocks", async () => {
    const a = await collect(withMaxTurnsAsTurnEnd(fake([{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "tool_use" } } }, maxTurns]))({}));
    const b = await collect(withMaxTurnsAsTurnEnd(fake([{ type: "assistant", message: { content: [{ type: "tool_use" }] } }, maxTurns]))({}));
    expect(a.at(-1).subtype).toBe("success");
    expect(b.at(-1).subtype).toBe("success");
  });
  it("leaves error_max_turns without a tool_use (and sub-agent tool_use) as an error", async () => {
    expect((await collect(withMaxTurnsAsTurnEnd(fake([maxTurns]))({}))).at(-1)).toMatchObject({ subtype: "error_max_turns", is_error: true });
    const sub = { ...toolStart, parent_tool_use_id: "p" };
    expect((await collect(withMaxTurnsAsTurnEnd(fake([sub, maxTurns]))({}))).at(-1).subtype).toBe("error_max_turns");
  });
  it("passes other messages through and forwards close()", async () => {
    const q = fake([toolStart, { type: "result", subtype: "success", is_error: false }])();
    const w: any = withMaxTurnsAsTurnEnd(() => q)({});
    expect(await collect(w)).toHaveLength(2);
    w.close();
    expect(q.close).toHaveBeenCalled();
  });
  it("keeps no state between two queryFn calls", async () => {
    const wrapped = withMaxTurnsAsTurnEnd(fake([maxTurns]), vi.fn());
    const first = withMaxTurnsAsTurnEnd(fake([toolStart, maxTurns]), vi.fn())({});
    expect((await collect(first)).at(-1).subtype).toBe("success");
    expect((await collect(wrapped({}))).at(-1).subtype).toBe("error_max_turns");
  });
  it("a tool_use of an earlier message does not excuse a max-turns error after a later tool-less message", async () => {
    const start = { type: "stream_event", event: { type: "message_start" } };
    expect((await collect(withMaxTurnsAsTurnEnd(fake([start, toolStart, start, maxTurns]), vi.fn())({}))).at(-1).subtype).toBe("error_max_turns");
  });
  it("an early break reaches the inner iterator", async () => {
    let finished = false;
    const inner = () => ({ async *[Symbol.asyncIterator]() { try { yield toolStart; yield maxTurns; } finally { finished = true; } }, close: vi.fn() });
    for await (const _ of withMaxTurnsAsTurnEnd(inner, vi.fn())({}) as any) break;
    expect(finished).toBe(true);
  });
  it("preserves usage, num_turns, session_id and cost on the rewritten result", async () => {
    const full = { ...maxTurns, usage: { input_tokens: 3 }, num_turns: 2, session_id: "sid", total_cost_usd: 0.5 };
    const r = (await collect(withMaxTurnsAsTurnEnd(fake([toolStart, full]), vi.fn())({}))).at(-1);
    expect(r).toMatchObject({ usage: { input_tokens: 3 }, num_turns: 2, session_id: "sid", total_cost_usd: 0.5 });
  });
  it("the default logger is console.warn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await collect(withMaxTurnsAsTurnEnd(fake([toolStart, maxTurns]))({}));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("rewrote error_max_turns"));
    } finally { warn.mockRestore(); }
  });
});
