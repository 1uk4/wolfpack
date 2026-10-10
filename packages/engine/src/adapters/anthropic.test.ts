import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { AnthropicAdapter } from "./anthropic.js";

/** A server-sent-events body the way the Messages API streams a reply. */
function sse(text: string, delayMs = 0, signal?: AbortSignal): Response {
  const events = [
    ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ...[...text].map((ch) => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ch } }]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const enc = new TextEncoder();
  const body = new ReadableStream({
    async start(ctrl) {
      for (const [name, data] of events) {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        // Like real fetch: an aborted request errors its body stream.
        if (signal?.aborted) return ctrl.error(signal.reason);
        ctrl.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      ctrl.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("AnthropicAdapter (streamed)", () => {
  const schema = z.object({ ok: z.boolean() });

  it("sends stream: true and assembles the streamed reply", async () => {
    const fetch = vi.fn(async (_url: unknown, init: any) => {
      expect(JSON.parse(init.body).stream).toBe(true);
      return sse('{"ok": true}');
    });
    const adapter = new AnthropicAdapter({ apiKey: "k", fetch: fetch as any });
    const { data, usage } = await adapter.extract(schema, { system: "s", prompt: "p", model: "m" });
    expect(data).toEqual({ ok: true });
    expect(usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
  });

  it("stops when the signal aborts mid-stream", async () => {
    const fetch = vi.fn(async (_u: unknown, init: any) => sse('{"ok": true}', 50, init.signal)); // ~1s to finish
    const adapter = new AnthropicAdapter({ apiKey: "k", fetch: fetch as any });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("budget")), 120);
    const started = Date.now();
    await expect(
      adapter.extract(schema, { system: "s", prompt: "p", model: "m", signal: controller.signal, maxRetries: 0 })
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(600); // stopped, not run to completion
  });
});
