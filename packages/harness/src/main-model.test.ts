import { describe, it, expect, vi } from "vitest";
import { createProvider } from "@earendil-works/pi-ai/models";
import { selectMainModel, startRoot } from "./main-model.js";
import { buildModelRegistry, guardProviderStreams } from "./wolfd/models.js";

const MODEL = "claude-sonnet-5-5";
const table = (provider: "anthropic" | "claude-bridge", model = MODEL) => ({ transport: provider === "anthropic" ? "api" : "subscription", tiers: { main: { model, provider, piProvider: provider, piModel: `${provider}/${model}` } } }) as never;

/** A real pi-ai provider (so the registry's getModel works) with a one-model table and spy shutdown/release. */
const fakeProvider = (ids: string[] = [MODEL], stream: () => never = () => { throw new Error("unused"); }) => {
  const models = ids.map((id) => ({ id, name: id, api: "claude-bridge", provider: "claude-bridge", baseUrl: "claude-bridge", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }));
  const base = createProvider({ id: "claude-bridge", auth: { apiKey: { name: "x", check: async () => ({ source: "t" }), resolve: async () => ({ auth: { apiKey: "x" }, source: "t" }) } }, models, api: { stream, streamSimple: stream } } as any);
  return Object.assign(base, { shutdown: vi.fn(), release: vi.fn(() => 0), liveQueries: 0 }) as never as import("pi-claude-bridge/core").ClaudeBridgeProvider;
};

const base = { cwd: "/tmp", loadSdkQuery: async () => () => {} };
const seam = (createProvider: () => unknown) => ({ "claude-bridge": { createProvider } });

describe("selectMainModel", () => {
  it("bridge tier → the bridge, with the resolved SDK query injected", async () => {
    const createProviderFn = vi.fn(() => fakeProvider());
    const query = () => {};
    const c = await selectMainModel({ ...base, loadSdkQuery: async () => query, table: table("claude-bridge"), env: {}, seams: seam(createProviderFn) });
    expect(c.model).toEqual({ provider: "claude-bridge", modelId: MODEL });
    expect(c.line).toBe("Main agent via claude-bridge");
    expect((createProviderFn.mock.calls[0] as unknown[])[0]).toMatchObject({ queryFn: query });
  });

  it("anthropic tier → anthropic only; the SDK is never loaded and the bridge never created", async () => {
    const loadSdkQuery = vi.fn(async () => () => {});
    const createProviderFn = vi.fn();
    const c = await selectMainModel({ ...base, loadSdkQuery, table: table("anthropic"), env: {}, seams: seam(createProviderFn) });
    expect(c.model).toEqual({ provider: "anthropic", modelId: MODEL });
    expect(c.models.getProvider("claude-bridge")).toBeUndefined();
    expect(loadSdkQuery).not.toHaveBeenCalled();
    expect(createProviderFn).not.toHaveBeenCalled();
  });

  it("a provider that fails to start fails startup (no silent spill onto the metered key)", async () => {
    await expect(selectMainModel({ ...base, table: table("claude-bridge"), env: {}, seams: seam(() => { throw new Error("boom"); }) })).rejects.toThrow(/claude-bridge.*boom/);
    await expect(selectMainModel({ ...base, loadSdkQuery: async () => { throw new Error("no sdk"); }, table: table("claude-bridge"), env: {} })).rejects.toThrow(/no sdk/);
  });

  it("a main model id missing from the provider table is refused and the half-built provider is disposed", async () => {
    const p = fakeProvider(["other-model"]);
    await expect(selectMainModel({ ...base, table: table("claude-bridge"), env: {}, seams: seam(() => p) })).rejects.toThrow(/not in the claude-bridge model table/);
    expect(p.shutdown).toHaveBeenCalledOnce();
  });

  it("forget and dispose reach the provider", async () => {
    const p = fakeProvider();
    const c = await selectMainModel({ ...base, table: table("claude-bridge"), env: {}, seams: seam(() => p) });
    c.forget("sess-1");
    expect(p.release).toHaveBeenCalledWith("sess-1");
    c.dispose();
    expect(p.shutdown).toHaveBeenCalledOnce();
  });
});

describe("startRoot", () => {
  const choice = { model: { provider: "claude-bridge", modelId: MODEL } } as never;
  it("opens on the chosen model and re-applies it with the thinking level", async () => {
    const configure = vi.fn(async () => {});
    const open = vi.fn(async () => ({ configure }));
    await startRoot(choice, open, "low", "ctx");
    expect(open).toHaveBeenCalledWith({ model: { provider: "claude-bridge", modelId: MODEL } });
    expect(configure).toHaveBeenCalledWith({ model: { provider: "claude-bridge", modelId: MODEL }, thinkingLevel: "low" }, "ctx");
  });
  it("a configure failure is logged, not fatal; an open failure propagates", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(startRoot(choice, async () => ({ configure: async () => { throw new Error("x"); } }), undefined, "ctx")).resolves.toBeDefined();
    await expect(startRoot(choice, async () => { throw new Error("open"); }, undefined, "ctx")).rejects.toThrow("open");
    err.mockRestore();
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

describe("guard through the registry", () => {
  it("models.streamSimple on a bridge whose stream throws yields an error event", async () => {
    const provider = fakeProvider([MODEL], () => { throw new Error("spawn failed"); });
    const b = buildModelRegistry(["claude-bridge"], { cwd: "/tmp", seams: seam(() => provider) });
    const model = b.models.getModel("claude-bridge", MODEL)!;
    const s = (b.models as any).streamSimple(model, { messages: [] });
    const events: any[] = [];
    for await (const e of s) events.push(e);
    expect(events[0]).toMatchObject({ type: "error", error: { errorMessage: "spawn failed" } });
  });
});
