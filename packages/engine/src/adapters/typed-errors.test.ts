import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AnthropicAdapter } from "./anthropic.js";
import { ClaudeAgentSdkAdapter, claudeChildEnv, isSdkInfraFailure, type QueryFn } from "./claude-agent-sdk.js";
import { LlmInfraError, OutputTruncatedError } from "./errors.js";

const schema = z.object({ ok: z.boolean() });
const base = { system: "s", prompt: "p", model: "claude-x", maxTokens: 16000 };

/** A fake SDK query yielding the given messages; records the options it was called with. */
function fakeQuery(messages: any[], calls: any[] = []): QueryFn {
  return ((params: any) => {
    calls.push(params);
    return (async function* () {
      for (const m of messages) yield m;
    })();
  }) as unknown as QueryFn;
}
const result = (over: Record<string, unknown>) => ({
  type: "result", subtype: "success", is_error: false, result: '{"ok": true}', usage: {}, total_cost_usd: 0, ...over,
});

describe("claude-agent-sdk adapter", () => {
  it("passes maxTokens to the child as CLAUDE_CODE_MAX_OUTPUT_TOKENS", async () => {
    expect(claudeChildEnv({}, 16000).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("16000");
    expect(claudeChildEnv({}).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined();
    const calls: any[] = [];
    const adapter = new ClaudeAgentSdkAdapter({ query: fakeQuery([result({})], calls) });
    await adapter.extract(schema, base);
    expect(calls[0].options.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe("16000");
  });

  it("throws OutputTruncatedError when the result stop_reason is max_tokens", async () => {
    const adapter = new ClaudeAgentSdkAdapter({ query: fakeQuery([result({ stop_reason: "max_tokens", result: '{"ok": tr' })]) });
    const err = await adapter.extract(schema, base).catch((e) => e);
    expect(err).toBeInstanceOf(OutputTruncatedError);
    expect(err).toMatchObject({ model: "claude-x", maxTokens: 16000, outputLength: 9 });
  });

  it("throws OutputTruncatedError on an assistant max_output_tokens error", async () => {
    const adapter = new ClaudeAgentSdkAdapter({
      query: fakeQuery([{ type: "assistant", error: "max_output_tokens", message: { content: [{ type: "text", text: "{" }] } }, result({ result: "{" })]),
    });
    await expect(adapter.extract(schema, base)).rejects.toBeInstanceOf(OutputTruncatedError);
  });

  it.each([
    ["usage limit text", result({ subtype: "success", is_error: true, result: "Claude AI usage limit reached|1760000000" })],
    ["weekly limit text", result({ is_error: true, result: "You've hit your limit · resets 5pm" })],
    ["429 status", result({ is_error: true, result: "boom", api_error_status: 429 })],
    ["auth expired", result({ is_error: true, result: "OAuth token has expired. Please run /login" })],
  ])("maps %s to LlmInfraError", async (_n, msg) => {
    const adapter = new ClaudeAgentSdkAdapter({ query: fakeQuery([msg]) });
    await expect(adapter.extract(schema, base)).rejects.toBeInstanceOf(LlmInfraError);
  });

  it("maps assistant error overloaded/rate_limit to LlmInfraError", async () => {
    const adapter = new ClaudeAgentSdkAdapter({
      query: fakeQuery([{ type: "assistant", error: "overloaded", message: { content: [] } }, result({ is_error: true, result: "API Error" })]),
    });
    await expect(adapter.extract(schema, base)).rejects.toBeInstanceOf(LlmInfraError);
  });

  it("wraps a spawn failure from the child as LlmInfraError", async () => {
    const q = (() => ({ [Symbol.asyncIterator]() { throw Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }); } })) as unknown as QueryFn;
    const err = await new ClaudeAgentSdkAdapter({ query: q }).extract(schema, base).catch((e) => e);
    expect(err).toBeInstanceOf(LlmInfraError);
  });

  it("treats error_max_turns as an item failure (plain Error, not infra)", async () => {
    const adapter = new ClaudeAgentSdkAdapter({
      query: fakeQuery([{ type: "result", subtype: "error_max_turns", is_error: true, usage: {}, total_cost_usd: 0 }]),
    });
    const err = await adapter.extract(schema, { ...base, maxRetries: 0 }).catch((e) => e);
    expect(err).not.toBeInstanceOf(LlmInfraError);
    expect(err.message).toMatch(/error_max_turns/);
    expect(isSdkInfraFailure({ text: "claude-agent-sdk query failed (error_max_turns)" })).toBe(false);
  });
});

describe("anthropic adapter truncation", () => {
  it("throws OutputTruncatedError on stop_reason max_tokens", async () => {
    const events = [
      ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: '{"ok": tr' } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "max_tokens", stop_sequence: null }, usage: { output_tokens: 16000 } }],
      ["message_stop", { type: "message_stop" }],
    ];
    const body = events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join("");
    const fetch = vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const adapter = new AnthropicAdapter({ apiKey: "k", fetch: fetch as any });
    const err = await adapter.extract(schema, base).catch((e) => e);
    expect(err).toBeInstanceOf(OutputTruncatedError);
    expect(err).toMatchObject({ maxTokens: 16000, outputLength: 9 });
    expect(fetch).toHaveBeenCalledTimes(1); // not retried
  });
});
