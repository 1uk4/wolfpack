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
});
