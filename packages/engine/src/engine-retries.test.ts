import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createEngine } from "./engine.js";
import { ClaudeAgentSdkAdapter } from "./adapters/claude-agent-sdk.js";
import { registerAdapter } from "./adapters/index.js";

const schema = z.object({ ok: z.boolean() });

/** A fake Agent SDK query that answers every request with prose, never JSON, and records each prompt it was sent. */
function badSdk() {
  const prompts: string[] = [];
  const query = ({ prompt }: { prompt: string }) => {
    prompts.push(prompt);
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "not json", usage: {}, total_cost_usd: 0 };
    })();
  };
  return { prompts, query };
}

describe("engine.call retries", () => {
  afterEach(() => undefined);

  it("sends the prompt once when the caller sets maxRetries 0 (a large consolidate prompt must not go out twice)", async () => {
    const sdk = badSdk();
    registerAdapter("fake-sdk-retries", () => new ClaudeAgentSdkAdapter({ query: sdk.query as never }));
    const engine = createEngine({ provider: "fake-sdk-retries", defaultModel: "m", usageLog: false } as never);
    await expect(engine.call("consolidate", schema, { system: "s", prompt: "BIG PROMPT", maxRetries: 0 })).rejects.toThrow(/1 attempts/);
    expect(sdk.prompts).toEqual(["BIG PROMPT"]);
  });
});
