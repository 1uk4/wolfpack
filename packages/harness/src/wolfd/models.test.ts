/** buildWolfModels: transport -> engine model registry. No SDK calls (provider factory is mocked). */
import { describe, expect, it, vi } from "vitest";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ClaudeBridgeProvider } from "pi-claude-bridge/core";
import { Type } from "typebox";
import { createClaudeBridgeProvider } from "pi-claude-bridge/core";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelTable, resolveWolfModel, tierPiProvider } from "@wolfpack/engine";
import { buildWolfModels, providersInUse } from "./models.js";

const fakeProvider = () => {
  const base = createProvider({ id: "claude-bridge", auth: { check: async () => "test" } as any, models: [], api: { stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } } } as any);
  return Object.assign(base, { shutdown: vi.fn(), release: vi.fn(() => 0), liveQueries: 0 }) as unknown as ClaudeBridgeProvider;
};

const tier = (provider: string, model = "m") => ({ model, provider: provider === "claude-bridge" ? "claude-agent-sdk" : provider, piModel: `${provider}/${model}`, piProvider: provider });
const table = (main: string, smart = main, fast = main, transport: "api" | "subscription" = "api") => ({ transport, tiers: { main: tier(main), smart: tier(smart), fast: tier(fast) } }) as never;
/** Bridge seam: a fake provider factory, or the real bridge core with a fake SDK query. */
const bridgeSeam = (createProvider: (o: any) => any) => ({ "claude-bridge": { createProvider } });
const subModels = (env: NodeJS.ProcessEnv, createProvider: (o: any) => any) => buildWolfModels(table("claude-bridge"), { cwd: "/w", env, seams: bridgeSeam(createProvider) });

describe("buildWolfModels", () => {
  it("anthropic-only tiers: no custom registry (engine default), bridge never created", () => {
    const create = vi.fn();
    const m = buildWolfModels(table("anthropic"), { cwd: "/w", seams: bridgeSeam(create) });
    expect(m.models).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(() => { m.forget("s"); m.dispose(); }).not.toThrow();
  });

  it("bridge-only tiers: registry holds claude-bridge only; dispose and forget reach the bridge entry", () => {
    const provider = fakeProvider();
    const create = vi.fn(() => provider);
    const m = buildWolfModels(table("claude-bridge", "claude-bridge", "claude-bridge", "subscription"), { cwd: "/w", env: { PATH: "/bin" }, seams: bridgeSeam(create) });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ cwd: "/w", env: { PATH: "/bin", ENABLE_TOOL_SEARCH: "false" } });
    expect(m.models!.getProvider("claude-bridge")).toBe(provider);
    expect(m.models!.getProvider("anthropic")).toBeUndefined();
    m.forget("sess-1");
    expect(provider.release).toHaveBeenCalledWith("sess-1");
    m.dispose();
    expect(provider.shutdown).toHaveBeenCalledOnce();
  });

  it("mixed providers per tier: one registry with both, built once each", () => {
    const provider = fakeProvider();
    const create = vi.fn(() => provider);
    const t = table("claude-bridge", "claude-bridge", "anthropic");
    expect(providersInUse(t)).toEqual(["claude-bridge", "anthropic"]);
    const m = buildWolfModels(t, { cwd: "/w", seams: bridgeSeam(create) });
    expect(create).toHaveBeenCalledOnce();
    expect(m.models!.getProvider("claude-bridge")).toBe(provider);
    expect(m.models!.getProvider("anthropic")).toBeDefined();
    m.forget("x"); // anthropic has no forget: a no-op for it, still reaches the bridge
    expect(provider.release).toHaveBeenCalledWith("x");
  });

  it("a tier config with no bridge never loads it, even with a bridge seam present", () => {
    const create = vi.fn();
    const m = buildWolfModels(table("anthropic", "anthropic", "openrouter"), { cwd: "/w", seams: bridgeSeam(create), factories: { anthropic: () => ({ provider: fakeProvider() as never }), openrouter: () => ({ provider: Object.assign(fakeProvider(), { id: "openrouter" }) as never }) } });
    expect(create).not.toHaveBeenCalled();
    expect(m.models).toBeDefined();
  });

  it("an unknown provider is refused naming the map; already-built providers are disposed", () => {
    const dispose = vi.fn();
    expect(() => buildWolfModels(table("anthropic", "nope"), { cwd: "/w", factories: { anthropic: () => ({ provider: fakeProvider() as never, dispose }) } })).toThrow(/no model provider "nope"/);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("legacy tables (transport only, no piProvider) resolve per transport", () => {
    const legacy = (transport: "api" | "subscription", prefix?: string) => ({ transport, tiers: { main: { model: "m", piModel: prefix ? `${prefix}/m` : undefined }, smart: { model: "m", piModel: prefix ? `${prefix}/m` : undefined }, fast: { model: "m", piModel: prefix ? `${prefix}/m` : undefined } } }) as never;
    expect(providersInUse(legacy("subscription", "claude-bridge"))).toEqual(["claude-bridge"]);
    expect(providersInUse(legacy("api", "anthropic"))).toEqual(["anthropic"]);
    expect(providersInUse(legacy("subscription"))).toEqual(["claude-bridge"]); // no piModel at all: the transport decides
    expect(providersInUse(legacy("api"))).toEqual(["anthropic"]);
  });
});

describe("resolveModelTable / resolveWolfModel: per-tier providers and legacy transport", () => {
  const pack = (extra: object = {}) => ({ main: { model: "claude-opus-5-5" }, smart: { model: "claude-sonnet-5-5" }, fast: { model: "claude-haiku-5-5" }, transport: { local: "subscription", vps: "api" }, ...extra }) as never;
  const cfg = { capability: {} } as never;

  it("legacy transport config maps to per-tier providers", () => {
    const sub = resolveModelTable({ pack: pack(), location: "local" });
    expect(Object.values(sub.tiers).map((t) => tierPiProvider(sub, t))).toEqual(["claude-bridge", "claude-bridge", "claude-bridge"]);
    expect(resolveWolfModel(cfg, "main", sub).provider).toBe("claude-bridge");
    const api = resolveModelTable({ pack: pack(), location: "vps" });
    expect(resolveWolfModel(cfg, "fast", api).provider).toBe("anthropic");
  });

  it("a tier's provider wins over the transport; others keep the default", () => {
    const t = resolveModelTable({ pack: pack({ fast: { model: "claude-haiku-5-5", provider: "anthropic" } }), location: "local" });
    expect(t.tiers.fast.piModel).toBe("anthropic/claude-haiku-5-5");
    expect(t.tiers.fast.provider).toBe("anthropic");
    expect(t.tiers.main.piModel).toBe("claude-bridge/claude-opus-5-5");
    expect(providersInUse(t)).toEqual(["claude-bridge", "anthropic"]);
    expect(resolveWolfModel(cfg, "fast", t).provider).toBe("anthropic");
  });

  it("a table file written before per-tier providers (no piProvider) still resolves", () => {
    const old = { location: "local", transport: "subscription", transportSource: "pack", warnings: [], steps: {}, tiers: { main: { model: "claude-opus-5-5", provider: "claude-agent-sdk", piModel: "claude-bridge/claude-opus-5-5" }, smart: { model: "s", provider: "claude-agent-sdk", piModel: "claude-bridge/s" }, fast: { model: "f", provider: "claude-agent-sdk", piModel: "claude-bridge/f" } } } as never;
    expect(resolveWolfModel(cfg, "main", old)).toMatchObject({ provider: "claude-bridge", piModel: "claude-bridge/claude-opus-5-5" });
  });
});

describe("harness stays provider-agnostic", () => {
  it("only providers/claude-bridge.ts imports or names the bridge (non-test sources)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const f = join(d, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !f.endsWith(join("providers", "claude-bridge.ts"))) {
          const code = readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
          if (/pi-claude-bridge|["'`]claude-bridge["'`]|createBridgeModels|sweepOrphans/.test(code)) hits.push(f.slice(root.length));
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});

describe("bridge seam: tool schemas reach the model inline", () => {
  it("task_bind is registered with the SDK query and tool search is off, so it is not deferred", async () => {
    const calls: any[] = [];
    const queryFn = ((args: any) => {
      calls.push(args.options);
      return (async function* () {})();
    }) as any;
    const m = subModels({ PATH: "/bin", ANTHROPIC_API_KEY: "x" }, (o) => createClaudeBridgeProvider({ ...o, queryFn, checkAuth: false, sweepOrphans: false }));
    const provider = m.models!.getProvider("claude-bridge") as any;
    const model = { id: "claude-haiku-4-5", name: "haiku", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
    const tools = [{ name: "task_bind", description: "Bind a work item", parameters: Type.Object({ id: Type.String() }) }];
    const s = provider.streamSimple(model, { systemPrompt: "sys", messages: [{ role: "user", content: "hi", timestamp: 0 }], tools }, {});
    for await (const _ of s) { /* drain */ }
    m.dispose();

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
    const m = subModels({ PATH: "/bin" }, (o) => createClaudeBridgeProvider({ ...o, queryFn, checkAuth: false, sweepOrphans: false }));
    const provider = m.models!.getProvider("claude-bridge") as any;
    const model = { id: "claude-haiku-4-5", name: "haiku", api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 };
    for await (const _ of provider.streamSimple(model, { systemPrompt: "sys", messages, tools: [] }, {})) { /* drain */ }
    m.dispose();
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
