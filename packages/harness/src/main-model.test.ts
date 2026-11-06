import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createProvider } from "@earendil-works/pi-ai/models";
import { selectMainModel, startRoot } from "./main-model.js";
import { buildModelRegistry, guardProviderStreams } from "./wolfd/models.js";

const MODEL = "claude-sonnet-5-5";
const table = (provider: "anthropic" | "claude-stateless", model = MODEL) => ({ transport: provider === "anthropic" ? "api" : "subscription", tiers: { main: { model, provider, piProvider: provider, piModel: `${provider}/${model}` } } }) as never;

/** A real pi-ai provider (so the registry's getModel works) with a one-model table and spy shutdown/release. */
const fakeProvider = (ids: string[] = [MODEL], stream: () => never = () => { throw new Error("unused"); }) => {
  const models = ids.map((id) => ({ id, name: id, api: "claude-stateless", provider: "claude-stateless", baseUrl: "claude-stateless", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 }));
  const base = createProvider({ id: "claude-stateless", auth: { apiKey: { name: "x", check: async () => ({ source: "t" }), resolve: async () => ({ auth: { apiKey: "x" }, source: "t" }) } }, models, api: { stream, streamSimple: stream } } as any);
  return Object.assign(base, { shutdown: vi.fn(), release: vi.fn(() => 0), liveQueries: 0 }) as never as { shutdown: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> } & ReturnType<typeof createProvider>;
};

const base = { cwd: "/tmp", loadSdkQuery: async () => () => {} };
const ENV = { WOLF_DEN: join(mkdtempSync(join(tmpdir(), "main-model-")), "den") };
const handle = (p: any) => ({ provider: p, forget: (id: string) => void p.release(id), dispose: () => p.shutdown() });
const seam = (createProvider: (o?: unknown) => unknown) => ({ "claude-stateless": { createProvider: (o: unknown) => { const p = createProvider(o) as any; return p?.provider ? p : handle(p); } } });

describe("selectMainModel", () => {
  it("bridge tier → the bridge, with the resolved SDK query injected", async () => {
    const createProviderFn = vi.fn((_o?: unknown) => fakeProvider());
    const query = () => {};
    const c = await selectMainModel({ ...base, loadSdkQuery: async () => query, table: table("claude-stateless"), env: ENV, seams: seam(createProviderFn) });
    expect(c.model).toEqual({ provider: "claude-stateless", modelId: MODEL });
    expect(c.line).toBe("Main agent via claude-stateless");
    expect((createProviderFn.mock.calls[0] as unknown[])[0]).toHaveProperty("queryFn");
  });

  it("anthropic tier → anthropic only; the SDK is never loaded and the bridge never created", async () => {
    const loadSdkQuery = vi.fn(async () => () => {});
    const createProviderFn = vi.fn();
    const c = await selectMainModel({ ...base, loadSdkQuery, table: table("anthropic"), env: ENV, seams: seam(createProviderFn) });
    expect(c.model).toEqual({ provider: "anthropic", modelId: MODEL });
    expect(c.models.getProvider("claude-stateless")).toBeUndefined();
    expect(loadSdkQuery).not.toHaveBeenCalled();
    expect(createProviderFn).not.toHaveBeenCalled();
  });

  it("a provider that fails to start fails startup (no silent spill onto the metered key)", async () => {
    await expect(selectMainModel({ ...base, table: table("claude-stateless"), env: ENV, seams: seam(() => { throw new Error("boom"); }) })).rejects.toThrow(/claude-stateless.*boom/);
    await expect(selectMainModel({ ...base, loadSdkQuery: async () => { throw new Error("no sdk"); }, table: table("claude-stateless"), env: ENV })).rejects.toThrow(/no sdk/);
  });

  it("a main model id missing from the provider table is refused and the half-built provider is disposed", async () => {
    const p = fakeProvider(["other-model"]);
    await expect(selectMainModel({ ...base, table: table("claude-stateless"), env: ENV, seams: seam(() => p) })).rejects.toThrow(/not in the claude-stateless model table/);
    expect(p.shutdown).toHaveBeenCalledOnce();
  });

  it("forget and dispose reach the provider", async () => {
    const p = fakeProvider();
    const c = await selectMainModel({ ...base, table: table("claude-stateless"), env: ENV, seams: seam(() => p) });
    c.forget("sess-1");
    expect(p.release).toHaveBeenCalledWith("sess-1");
    c.dispose();
    expect(p.shutdown).toHaveBeenCalledOnce();
  });
});

describe("startRoot", () => {
  const choice = { model: { provider: "claude-stateless", modelId: MODEL } } as never;
  it("opens on the chosen model and re-applies it with the thinking level", async () => {
    const configure = vi.fn(async () => {});
    const open = vi.fn(async () => ({ configure }));
    await startRoot(choice, open, "low", "ctx");
    expect(open).toHaveBeenCalledWith({ model: { provider: "claude-stateless", modelId: MODEL } });
    expect(configure).toHaveBeenCalledWith({ model: { provider: "claude-stateless", modelId: MODEL }, thinkingLevel: "low" }, "ctx");
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
    const p = guardProviderStreams({ stream: () => { throw new Error("spawn failed"); }, streamSimple: () => { throw new Error("spawn failed"); } }, { provider: "claude-stateless" });
    for (const fn of [p.stream, p.streamSimple] as any[]) {
      const s = fn({ id: MODEL, provider: "claude-stateless", api: "claude-stateless" }, {});
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
    const b = buildModelRegistry(["claude-stateless"], { cwd: "/tmp", env: ENV, seams: seam(() => provider) });
    const model = b.models.getModel("claude-stateless", MODEL)!;
    const s = (b.models as any).streamSimple(model, { messages: [] });
    const events: any[] = [];
    for await (const e of s) events.push(e);
    expect(events[0]).toMatchObject({ type: "error", error: { errorMessage: "spawn failed" } });
  });
});
