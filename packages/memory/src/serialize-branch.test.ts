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

describe("pi-durable message shapes (opt-in tools)", () => {
  const durable = [
    msg("1", "assistant", [{ type: "toolCall", name: "write", arguments: { path: "a.txt" } }]),
    msg("2", "toolResult", [{ type: "text", text: "wrote a.txt" }]),
  ];
  it("default output (pi's path) ignores toolCall blocks and toolResult messages, byte-identical to before", () => {
    expect(serializeBranchEntries(durable)).toEqual([]);
    expect(serializeBranchEntries([msg("1", "assistant", [{ type: "text", text: "hi" }, { type: "tool_use", name: "bash", input: { c: "ls" } }]), msg("2", "tool", "out")]))
      .toEqual([
        { id: "1", text: '[assistant] hi\n[Tool call: bash({"c":"ls"})]', tokens: Math.ceil('hi\n[Tool call: bash({"c":"ls"})]'.length / 4) },
        { id: "2", text: "[tool] [Tool result: out]", tokens: Math.ceil("[Tool result: out]".length / 4) },
      ]);
  });
  it("reads toolCall blocks and toolResult messages with { tools: true }", () => {
    const out = serializeBranchEntries(durable, { tools: true });
    expect(out[0].text).toContain('[Tool call: write({"path":"a.txt"})]');
    expect(out[1].text).toBe("[toolResult] [Tool result: wrote a.txt]");
  });
});

describe("excludeSubagentTraffic", () => {
  // Shapes captured from wolf 1uk4's durable session store (shortened): a delivered subagent result lands as a
  // plain `user` message; no customType or details survive, only its text identifies it.
  const result = msg("r", "user", 'Sub-agent "task-log-plan" completed (48s).\n\nI\'ll find the classify step first.\n\n# Addendum\n\nFollow up with subagent_message({ name: "task-log-plan", message: "…" })\n\n[delivery sub-a858a5ef.228c6390]');
  const merge = msg("m", "user", 'Sub-agent "work-reads-scoped" merge: Not merged: conflicts\n\n[delivery sub-0e5b1c22.9a3f4d10]');
  const brief = msg("b", "assistant", [{ type: "toolCall", id: "t1", name: "subagent", arguments: { name: "x", task: "do the thing" } }, { type: "toolCall", id: "t2", name: "bash", arguments: { command: "ls" } }]);
  const subResult = { id: "s", type: "message", message: { role: "toolResult", toolCallId: "t1", toolName: "subagent", content: [{ type: "text", text: "started x" }] } };
  const bashResult = { id: "k", type: "message", message: { role: "toolResult", toolCallId: "t2", content: [{ type: "text", text: "a.txt" }] } };
  const opts = { tools: true, excludeSubagentTraffic: true };

  it("drops a subagent result delivered as a user message", () => {
    const out = serializeBranchEntries([msg("u", "user", "please go on"), result, merge], opts);
    expect(out.map((o) => o.id)).toEqual(["u"]);
  });
  it("drops toolResults of subagent tools (matched by call id), keeps the brief toolCall and other tool results", () => {
    const out = serializeBranchEntries([brief, subResult, bashResult], opts);
    expect(out.map((o) => o.id)).toEqual(["b", "k"]);
    expect(out[0].text).toContain('[Tool call: subagent({"name":"x","task":"do the thing"})]');
  });
  it("keeps a user message that merely mentions Sub-agent or a delivery", () => {
    const talk = msg("t", "user", 'Did Sub-agent "task-log-plan" completed ok? the [delivery sub-a858a5ef.228c6390] line looked odd');
    expect(serializeBranchEntries([talk], opts).map((o) => o.id)).toEqual(["t"]);
  });
  it("is unchanged with the option off", () => {
    expect(serializeBranchEntries([result, brief, subResult], { tools: true }).map((o) => o.id)).toEqual(["r", "b", "s"]);
  });
});

describe("chunkSerialized", () => {
  it("splits on the token limit and ids a chunk by its last entry", () => {
    const e = (id: string, tokens: number) => ({ id, text: id, tokens });
    expect(chunkSerialized([e("a", 3), e("b", 3), e("c", 3)], 6).map((c) => [c.id, c.tokenCount])).toEqual([["b", 6], ["c", 3]]);
    expect(chunkSerialized([])).toEqual([]);
  });
});
