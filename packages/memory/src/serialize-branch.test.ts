import { describe, it, expect } from "vitest";
import { chunkSerialized, serializeBranchEntries } from "./serialize-branch.js";

const msg = (id: string, role: string, content: unknown) => ({ id, type: "message", message: { role, content } });

describe("serializeBranchEntries", () => {
  it("reads user / assistant / tool messages", () => {
    const out = serializeBranchEntries([
      msg("1", "user", "hello"),
      msg("2", "assistant", [{ type: "text", text: "hi" }, { type: "tool_use", name: "bash", input: { c: "ls" } }]),
      msg("3", "tool", "output"),
    ]);
    expect(out.map((o) => o.id)).toEqual(["1", "2", "3"]);
    expect(out[1].text).toContain("[Tool call: bash(");
  });

  it("ignores custom_message entries, subagent reports included", () => {
    const cm = (id: string, customType: string) => ({ id, type: "custom_message", customType, content: "lots of findings", details: { name: "w" } });
    const out = serializeBranchEntries([cm("a", "subagent_result"), cm("b", "subagent_question"), cm("c", "subagent_status"), msg("k", "user", "keep me")]);
    expect(out.map((o) => o.id)).toEqual(["k"]);
  });
});

describe("pi-durable message shapes", () => {
  it("reads toolCall blocks and toolResult messages", () => {
    const out = serializeBranchEntries([
      msg("1", "assistant", [{ type: "toolCall", name: "write", arguments: { path: "a.txt" } }]),
      msg("2", "toolResult", [{ type: "text", text: "wrote a.txt" }]),
    ]);
    expect(out[0].text).toContain('[Tool call: write({"path":"a.txt"})]');
    expect(out[1].text).toBe("[toolResult] [Tool result: wrote a.txt]");
  });
});

describe("chunkSerialized", () => {
  it("splits on the token limit and ids a chunk by its last entry", () => {
    const e = (id: string, tokens: number) => ({ id, text: id, tokens });
    expect(chunkSerialized([e("a", 3), e("b", 3), e("c", 3)], 6).map((c) => [c.id, c.tokenCount])).toEqual([["b", 6], ["c", 3]]);
    expect(chunkSerialized([])).toEqual([]);
  });
});
