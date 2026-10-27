/** buildWolfModels: transport -> engine model registry. No SDK calls (provider factory is mocked). */
import { describe, expect, it, vi } from "vitest";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ClaudeBridgeProvider } from "pi-claude-bridge/core";
import { Type } from "typebox";
import { createClaudeBridgeProvider } from "pi-claude-bridge/core";
import { buildWolfModels } from "./models.js";

const fakeProvider = () => {
  const base = createProvider({ id: "claude-bridge", auth: { check: async () => "test" } as any, models: [], api: { stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } } } as any);
  return Object.assign(base, { shutdown: vi.fn(), liveQueries: 0 }) as unknown as ClaudeBridgeProvider;
};

describe("buildWolfModels", () => {
  it("api transport: no custom registry (engine default anthropic provider)", () => {
    const create = vi.fn();
    const m = buildWolfModels({ transport: "api", provider: "anthropic" }, { cwd: "/w", createProvider: create });
    expect(m.models).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    m.shutdown();
  });

  it("subscription transport: registry holds claude-bridge only, shutdown reaches the provider", () => {
    const provider = fakeProvider();
    const create = vi.fn(() => provider);
    const env = { PATH: "/bin" };
    const m = buildWolfModels({ transport: "subscription", provider: "claude-bridge" }, { cwd: "/w", env, createProvider: create });
    expect(create).toHaveBeenCalledWith({ cwd: "/w", env: { PATH: "/bin", ENABLE_TOOL_SEARCH: "false" } });
    expect(m.models).toBeDefined();
    expect(m.models!.getProvider("claude-bridge")).toBe(provider);
    expect(m.models!.getProvider("anthropic")).toBeUndefined();
    m.shutdown();
    expect(provider.shutdown).toHaveBeenCalledOnce();
  });

  it("subscription transport with a mismatched provider id is refused", () => {
    expect(() => buildWolfModels({ transport: "subscription", provider: "anthropic" }, { cwd: "/w", createProvider: vi.fn() })).toThrow(/claude-bridge/);
  });
});

describe("bridge seam: tool schemas reach the model inline", () => {
  it("task_bind is registered with the SDK query and tool search is off, so it is not deferred", async () => {
    const calls: any[] = [];
    const queryFn = ((args: any) => {
      calls.push(args.options);
      return (async function* () {})();
    }) as any;
    const m = buildWolfModels(
      { transport: "subscription", provider: "claude-bridge" },
      { cwd: "/w", env: { PATH: "/bin", ANTHROPIC_API_KEY: "x" }, createProvider: (o) => createClaudeBridgeProvider({ ...o, queryFn, checkAuth: false, sweepOrphans: false }) },
    );
    const provider = m.models!.getProvider("claude-bridge") as any;
    const model = { id: "claude-haiku-4-5", name: "haiku", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
    const tools = [{ name: "task_bind", description: "Bind a work item", parameters: Type.Object({ id: Type.String() }) }];
    const s = provider.streamSimple(model, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools }, {});
    for await (const _ of s) { /* drain */ }
    m.shutdown();

    expect(calls).toHaveLength(1);
    const o = calls[0];
    expect(o.tools).toEqual([]); // no ToolSearch built-in to load deferred schemas with...
    expect(o.env.ENABLE_TOOL_SEARCH).toBe("false"); // ...so deferral must be off
    expect(o.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(o.mcpServers)).toHaveLength(1);
    expect(o.allowedTools).toEqual([expect.stringMatching(/__task_bind$/)]);
  });
});

describe("bridge seam: images reach the SDK query", () => {
  const png = { type: "image", data: "UElYRUw=", mimeType: "image/png" };
  const toolImage = { type: "image", data: "VE9PTA==", mimeType: "image/png" };

  /** Run one turn through the real bridge core with a fake SDK and return the first user message it was fed. */
  async function firstSdkMessage(messages: any[]) {
    let first: any;
    const queryFn = ((args: any) => {
      first = (async () => (await args.prompt[Symbol.asyncIterator]().next()).value)();
      return (async function* () {})();
    }) as any;
    const m = buildWolfModels(
      { transport: "subscription", provider: "claude-bridge" },
      { cwd: "/w", env: { PATH: "/bin" }, createProvider: (o) => createClaudeBridgeProvider({ ...o, queryFn, checkAuth: false, sweepOrphans: false }) },
    );
    const provider = m.models!.getProvider("claude-bridge") as any;
    const model = { id: "claude-haiku-4-5", name: "haiku", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
    for await (const _ of provider.streamSimple(model, { systemPrompt: "sys", messages, tools: [] }, {})) { /* drain */ }
    m.shutdown();
    return first;
  }
  const blocks = (msg: any) => msg.message.content.filter((b: any) => b.type === "image").map((b: any) => b.source.data);
  const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], api: "claude-bridge", provider: "claude-bridge", model: "x", usage: {}, stopReason: "stop", timestamp: 0 };

  it("an image on the first user message", async () => {
    const msg = await firstSdkMessage([{ role: "user", content: [{ type: "text", text: "look" }, png], timestamp: 0 }]);
    expect(blocks(msg)).toEqual([png.data]);
  });

  // After the first turn the transcript holds earlier messages, and a fresh SDK query (first round of a resumed
  // thread, crash recovery) is fed the whole history rendered as one prompt: the path that used to flatten images to "[image]".
  it("an image on a later user message, after earlier turns (the thread rebuilds its query)", async () => {
    const msg = await firstSdkMessage([
      { role: "user", content: "hi", timestamp: 0 },
      assistant,
      { role: "user", content: [{ type: "text", text: "and this?" }, png], timestamp: 1 },
    ]);
    expect(blocks(msg)).toEqual([png.data]);
    expect(JSON.stringify(msg.message.content)).not.toContain("[image]");
  });

  it("an image returned by a tool", async () => {
    const msg = await firstSdkMessage([
      { role: "user", content: "read it", timestamp: 0 },
      { ...assistant, content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a.png" } }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "t1", toolName: "read", content: [toolImage], isError: false, timestamp: 1 },
    ]);
    expect(blocks(msg)).toEqual([toolImage.data]);
  });
});
