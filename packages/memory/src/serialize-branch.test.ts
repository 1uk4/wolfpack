import { describe, it, expect } from "vitest";
import { serializeBranchEntries, isRecordedReport, RECORDED_REPORT_KEY } from "./serialize-branch.js";

const msg = (id: string, role: string, content: unknown, extra: object = {}) => ({ id, type: "message", message: { role, content, ...extra } });

describe("serializeBranchEntries", () => {
  it("reads user / assistant / tool messages, as before", () => {
    const out = serializeBranchEntries([
      msg("1", "user", "hello"),
      msg("2", "assistant", [{ type: "text", text: "hi" }, { type: "tool_use", name: "bash", input: { c: "ls" } }]),
      msg("3", "tool", "output"),
    ]);
    expect(out.map((o) => o.id)).toEqual(["1", "2", "3"]);
    expect(out[1].text).toContain("[Tool call: bash(");
  });

  it("does not read extension-injected entries (an unmarked subagent report stays as it was)", () => {
    const report = { id: "r1", type: "custom_message", customType: "subagent_result", content: "Sub-agent \"w\" completed.\n\nlots of findings", details: { name: "w" } };
    expect(serializeBranchEntries([report])).toEqual([]);
  });

  it("skips a marked report whatever entry shape carries it", () => {
    const marked = { [RECORDED_REPORT_KEY]: true, workItem: "work-1" };
    const entries = [
      { id: "m1", type: "custom_message", customType: "subagent_result", content: "report one", details: marked },
      // a pi version that stores it as a message with role "custom", or even as a user message
      msg("m2", "custom", "report two", { details: marked }),
      msg("m3", "user", "report three", { details: marked }),
      msg("k", "user", "keep me"),
    ];
    expect(entries.slice(0, 3).every(isRecordedReport)).toBe(true);
    expect(serializeBranchEntries(entries).map((o) => o.id)).toEqual(["k"]);
  });

  it("an unmarked message with details is still read", () => {
    expect(serializeBranchEntries([msg("a", "user", "x", { details: { workItem: "work-1" } })]).map((o) => o.id)).toEqual(["a"]);
  });
});
