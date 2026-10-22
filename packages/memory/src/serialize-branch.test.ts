import { describe, it, expect } from "vitest";
import { serializeBranchEntries } from "./serialize-branch.js";

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
