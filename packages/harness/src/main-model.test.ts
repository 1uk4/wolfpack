import { describe, it, expect, vi } from "vitest";
import { createProvider } from "@earendil-works/pi-ai/models";
import { selectMainModel, startRoot } from "./main-model.js";
import { guardProviderStreams } from "./wolfd/models.js";

const MODEL = "claude-sonnet-5-5";
const table = (transport: "api" | "subscription", model = MODEL) => ({ transport, tiers: { main: { model } } }) as never;

/** A real pi-ai provider (so the registry's getModel works) with a one-model table and spy shutdown/release. */
const fakeProvider = (ids: string[] = [MODEL], stream: () => never = () => { throw new Error("unused"); }) => {
  const models = ids.map((id) => ({ id, name: id, api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }));
  const base = createProvider({ id: "claude-bridge", auth: { apiKey: { name: "x", check: async () => ({ source: "t" }), resolve: async () => ({ auth: { apiKey: "x" }, source: "t" }) } }, models, api: { stream, streamSimple: stream } } as any);
  return Object.assign(base, { shutdown: vi.fn(), release: vi.fn(() => 0), liveQueries: 0 }) as never as import("pi-claude-bridge/core").ClaudeBridgeProvider;
};

const base = { cwd: "/tmp", loadSdkQuery: async () => () => {} };
const sub = { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" };

describe("selectMainModel", () => {
  it("subscription + token → the bridge, with the resolved SDK query injected", async () => {
    const createProviderFn = vi.fn(() => fakeProvider());
    const query = () => {};
    const c = await selectMainModel({ ...base, loadSdkQuery: async () => query, table: table("subscription"), env: sub, createProvider: createProviderFn });
    expect(c.via).toBe("bridge");
    expect(c.model).toEqual({ provider: "claude-bridge", modelId: MODEL });
    expect(c.line).toBe("Main agent via Max subscription (claude-bridge)");
    expect((createProviderFn.mock.calls[0] as unknown[])[0]).toMatchObject({ queryFn: query });
  });

  it("api transport → anthropic, bridge never created", async () => {
    const createProviderFn = vi.fn(() => fakeProvider());
    const c = await selectMainModel({ ...base, table: table("api"), env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, createProvider: createProviderFn });
    expect(c.via).toBe("api");
    expect(c.model).toEqual({ provider: "anthropic", modelId: MODEL });
    expect(c.line).toBe("Main agent via API key (transport api)");
    expect(createProviderFn).not.toHaveBeenCalled();
  });

  it("subscription without a token → anthropic with the reason", async () => {
    const createProviderFn = vi.fn(() => fakeProvider());
    const c = await selectMainModel({ ...base, table: table("subscription"), env: {}, createProvider: createProviderFn });
    expect(c.via).toBe("api");
    expect(c.line).toContain("no CLAUDE_CODE_OAUTH_TOKEN");
    expect(createProviderFn).not.toHaveBeenCalled();
  });

  it("bridge init throws → anthropic with a warning", async () => {
    const c = await selectMainModel({ ...base, table: table("subscription"), env: sub, createProvider: () => { throw new Error("boom"); } });
    expect(c.via).toBe("api");
    expect(c.model.provider).toBe("anthropic");
    expect(c.warning).toContain("boom");
  });

  it("Agent SDK not loadable → anthropic with a warning", async () => {
    const c = await selectMainModel({ ...base, loadSdkQuery: async () => { throw new Error("sdk missing"); }, table: table("subscription"), env: sub, createProvider: () => fakeProvider() });
    expect(c.via).toBe("api");
    expect(c.warning).toContain("sdk missing");
  });

  it("a main model id missing from the bridge table → anthropic with the reason, and the half-built bridge is shut down", async () => {
    const provider = fakeProvider(["other-model"]);
    const c = await selectMainModel({ ...base, table: table("subscription", "claude-unknown-9"), env: sub, createProvider: () => provider });
    expect(c.via).toBe("api");
    expect(c.model).toEqual({ provider: "anthropic", modelId: "claude-unknown-9" });
    expect(c.line).toContain("claude-unknown-9");
    expect(c.warning).toMatch(/not in the claude-bridge model table/);
    expect(provider.shutdown).toHaveBeenCalledOnce();
  });

  it("release and shutdown reach the bridge; shutdown is idempotent; both are no-ops on the API", async () => {
    const provider = fakeProvider();
    const c = await selectMainModel({ ...base, table: table("subscription"), env: sub, createProvider: () => provider });
    c.release("sess-1");
    expect(provider.release).toHaveBeenCalledWith("sess-1");
    c.shutdown(); c.shutdown();
    expect(provider.shutdown).toHaveBeenCalledOnce();
    const api = await selectMainModel({ ...base, table: table("api"), env: {} });
    expect(() => { api.release("x"); api.shutdown(); }).not.toThrow();
  });

  it("while on the bridge, a stored provider \"anthropic\" ref resolves to the bridge model; after fallback it resolves on anthropic", async () => {
    const c = await selectMainModel({ ...base, table: table("subscription"), env: sub, createProvider: () => fakeProvider() });
    expect(c.models.getModel("anthropic", MODEL)?.provider).toBe("claude-bridge");
    c.fallBackToApi("test");
    expect(c.via).toBe("api");
    expect(c.models.getModel("anthropic", MODEL)?.provider).toBe("anthropic");
    expect(c.models.getModel("claude-bridge", MODEL)).toBeUndefined();
  });
});

describe("startRoot", () => {
  const bridgeChoice = () => selectMainModel({ ...base, table: table("subscription"), env: sub, createProvider: () => fakeProvider() });

  it("configure failure on the bridge → falls back to the API key and reconfigures on anthropic", async () => {
    const c = await bridgeChoice();
    const configure = vi.fn().mockRejectedValueOnce(new Error("model not found")).mockResolvedValue(undefined);
    const warn = vi.fn();
    await startRoot(c, async () => ({ configure }), undefined, {}, { warn });
    expect(c.via).toBe("api");
    expect(configure).toHaveBeenCalledTimes(2);
    expect(configure.mock.calls[0]![0].model.provider).toBe("claude-bridge");
    expect(configure.mock.calls[1]![0].model).toEqual({ provider: "anthropic", modelId: MODEL });
    expect(warn.mock.calls.join("\n")).toMatch(/falling back to the API key/);
  });

  it("opening the root on the bridge fails → falls back and opens again on anthropic", async () => {
    const c = await bridgeChoice();
    const open = vi.fn().mockRejectedValueOnce(new Error("no model")).mockResolvedValue({ configure: async () => {} });
    await startRoot(c, open, undefined, {}, { warn: () => {} });
    expect(open.mock.calls[1]![0].model.provider).toBe("anthropic");
  });

  it("a healthy bridge stays on the bridge", async () => {
    const c = await bridgeChoice();
    const configure = vi.fn().mockResolvedValue(undefined);
    await startRoot(c, async () => ({ configure }), "low", {}, { warn: () => {} });
    expect(c.via).toBe("bridge");
    expect(configure).toHaveBeenCalledOnce();
  });
});

describe("guardProviderStreams: a throwing provider reports an error stream event, never a throw/rejection", () => {
  it("stream() and streamSimple() that throw synchronously yield an error event", async () => {
    const p = guardProviderStreams({ stream: () => { throw new Error("spawn failed"); }, streamSimple: () => { throw new Error("spawn failed"); } }, { provider: "claude-bridge" });
    for (const fn of [p.stream, p.streamSimple] as any[]) {
      const s = fn({ id: MODEL, provider: "claude-bridge", api: "claude-bridge" }, {});
      const events: any[] = [];
      for await (const e of s) events.push(e);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: "error", reason: "error", error: { stopReason: "error", errorMessage: "spawn failed" } });
      await expect(s.result()).resolves.toMatchObject({ stopReason: "error" });
    }
  });
});
