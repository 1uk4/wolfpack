import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEngine } from "./engine.js";
import { readUsageLog } from "./usage-log.js";

/** A streamed Messages API reply with usage incl. cache tokens. */
function sse(text: string): Response {
  const usage = { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 500, cache_creation_input_tokens: 40 };
  const events = [
    ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "m", content: [], stop_reason: null, stop_sequence: null, usage } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = events.map(([n, d]) => `event: ${n}\ndata: ${JSON.stringify(d)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const schema = z.object({ ok: z.boolean() });
const call = (engine: ReturnType<typeof createEngine>) => engine.call("classify", schema, { system: "s", prompt: "p" });

describe("engine usage log", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("appends one event per call with tokens, step and billing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse('{"ok": true}')));
    const den = fs.mkdtempSync(path.join(os.tmpdir(), "usage-den-"));
    const engine = createEngine({
      provider: "anthropic",
      apiKey: "k",
      defaultModel: "claude-haiku-5-5",
      usageLog: { den, wolf: "hal" },
    });
    await call(engine);
    const events = readUsageLog(den);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      wolf: "hal",
      source: "engine",
      use: "step:classify",
      provider: "anthropic",
      billing: "api",
      model: "claude-haiku-5-5",
      input: 11,
      output: 7,
      cacheRead: 500,
      cacheWrite: 40,
      costSource: "unknown",
    });
  });

  it("defaults to WOLF_DEN / WOLF_NAME and can be turned off", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse('{"ok": true}')));
    const den = fs.mkdtempSync(path.join(os.tmpdir(), "usage-den-"));
    vi.stubEnv("WOLF_DEN", den);
    vi.stubEnv("WOLF_NAME", "dewey");
    await call(createEngine({ provider: "anthropic", apiKey: "k", defaultModel: "m" }));
    await call(createEngine({ provider: "anthropic", apiKey: "k", defaultModel: "m", usageLog: false }));
    const events = readUsageLog(den);
    expect(events).toHaveLength(1);
    expect(events[0]!.wolf).toBe("dewey");
  });

  it("writes nothing when no den is known", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => sse('{"ok": true}')));
    await expect(call(createEngine({ provider: "anthropic", apiKey: "k", defaultModel: "m" }))).resolves.toEqual({ ok: true });
  });
});
