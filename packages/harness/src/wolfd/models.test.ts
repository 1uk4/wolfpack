/** buildWolfModels: transport -> engine model registry. No SDK calls (provider factory is mocked). */
import { afterAll, describe, expect, it, vi } from "vitest";
import { createProvider } from "@earendil-works/pi-ai/models";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { join } from "node:path";
import { resolveModelTable, resolveWolfModel, tierPiProvider } from "@wolfpack/engine";
import { buildModelRegistry, buildWolfModels, providersInUse, storedProviderIds } from "./models.js";

const fakeProvider = () => {
  const base = createProvider({ id: "claude-stateless", auth: { check: async () => "test" } as any, models: [], api: { stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } } } as any);
  return Object.assign(base, { shutdown: vi.fn(), release: vi.fn(() => 0), liveQueries: 0 }) as any;
};

const tier = (provider: string, model = "m") => ({ model, provider: provider === "claude-stateless" ? "claude-agent-sdk" : provider, piModel: `${provider}/${model}`, piProvider: provider });
const table = (main: string, smart = main, fast = main, transport: "api" | "subscription" = "api") => ({ transport, tiers: { main: tier(main), smart: tier(smart), fast: tier(fast) } }) as never;
/** Bridge seam: a fake provider factory, or the real bridge core with a fake SDK query. */
const bridgeSeam = (createProvider: (o: any) => any) => ({ "claude-stateless": { createProvider: (o: any) => { const p = createProvider(o); return p?.provider ? p : { provider: p, forget: (id: string) => void p.release(id), dispose: () => p.shutdown() }; } } });
const subModels = (env: NodeJS.ProcessEnv, createProvider: (o: any) => any) => buildWolfModels(table("claude-stateless"), { cwd: "/w", env, seams: bridgeSeam(createProvider) });

const DEN_ROOT = mkdtempSync(join(tmpdir(), "models-test-"));
process.env.WOLF_DEN = join(DEN_ROOT, "den"); // the claude-stateless factory refuses to start without it
afterAll(() => rmSync(DEN_ROOT, { recursive: true, force: true }));

describe("buildWolfModels", () => {
  it("anthropic-only tiers: no custom registry (engine default), bridge never created", () => {
    const create = vi.fn();
    const m = buildWolfModels(table("anthropic"), { cwd: "/w", seams: bridgeSeam(create) });
    expect(m.models).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    expect(() => { m.forget("s"); m.dispose(); }).not.toThrow();
  });

  it("bridge-only tiers: registry holds claude-stateless only; dispose and forget reach its entry", () => {
    const provider = fakeProvider();
    const create = vi.fn(() => provider);
    const m = buildWolfModels(table("claude-stateless", "claude-stateless", "claude-stateless", "subscription"), { cwd: "/w", env: { PATH: "/bin", WOLF_DEN: process.env.WOLF_DEN }, seams: bridgeSeam(create) });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: "claude-stateless", env: { PATH: "/bin", WOLF_DEN: process.env.WOLF_DEN, ENABLE_TOOL_SEARCH: "false" } }));
    expect(m.models!.getProvider("claude-stateless")).toBe(provider);
    expect(m.models!.getProvider("anthropic")).toBeUndefined();
    m.forget("sess-1");
    expect(provider.release).toHaveBeenCalledWith("sess-1");
    m.dispose();
    expect(provider.shutdown).toHaveBeenCalledOnce();
  });

  it("mixed providers per tier: one registry with both, built once each", () => {
    const provider = fakeProvider();
    const create = vi.fn(() => provider);
    const t = table("claude-stateless", "claude-stateless", "anthropic");
    expect(providersInUse(t)).toEqual(["claude-stateless", "anthropic"]);
    const m = buildWolfModels(t, { cwd: "/w", seams: bridgeSeam(create) });
    expect(create).toHaveBeenCalledOnce();
    expect(m.models!.getProvider("claude-stateless")).toBe(provider);
    expect(m.models!.getProvider("anthropic")?.id).toBe("anthropic");
    m.forget("x"); // anthropic has no forget: a no-op for it, still reaches the bridge
    expect(provider.release).toHaveBeenCalledWith("x");
  });

  it("a tier config with no bridge never loads it, even with a bridge seam present", () => {
    const create = vi.fn();
    const m = buildWolfModels(table("anthropic", "anthropic", "openrouter"), { cwd: "/w", seams: bridgeSeam(create), factories: { anthropic: () => ({ provider: fakeProvider() as never }), openrouter: () => ({ provider: Object.assign(fakeProvider(), { id: "openrouter" }) as never }) } });
    expect(create).not.toHaveBeenCalled();
  });

  it("an unknown provider is refused naming the map; already-built providers are disposed", () => {
    const dispose = vi.fn();
    expect(() => buildWolfModels(table("anthropic", "nope"), { cwd: "/w", factories: { anthropic: () => ({ provider: fakeProvider() as never, dispose }) } })).toThrow(/no model provider "nope"/);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("legacy tables (transport only, no piProvider) resolve per transport", () => {
    const legacy = (transport: "api" | "subscription", prefix?: string) => ({ transport, tiers: { main: { model: "m", piModel: prefix ? `${prefix}/m` : undefined }, smart: { model: "m", piModel: prefix ? `${prefix}/m` : undefined }, fast: { model: "m", piModel: prefix ? `${prefix}/m` : undefined } } }) as never;
    expect(providersInUse(legacy("subscription", "claude-stateless"))).toEqual(["claude-stateless"]);
    expect(providersInUse(legacy("api", "anthropic"))).toEqual(["anthropic"]);
    expect(providersInUse(legacy("subscription"))).toEqual(["claude-stateless"]); // no piModel at all: the transport decides
    expect(providersInUse(legacy("api"))).toEqual(["anthropic"]);
  });
});

describe("resolveModelTable / resolveWolfModel: per-tier providers and legacy transport", () => {
  const pack = (extra: object = {}) => ({ main: { model: "claude-opus-5-5" }, smart: { model: "claude-sonnet-5-5" }, fast: { model: "claude-haiku-5-5" }, transport: { local: "subscription", vps: "api" }, ...extra }) as never;
  const cfg = { capability: {} } as never;

  it("legacy transport config maps to per-tier providers", () => {
    const sub = resolveModelTable({ pack: pack(), location: "local" });
    expect(Object.values(sub.tiers).map((t) => tierPiProvider(sub, t))).toEqual(["claude-stateless", "claude-stateless", "claude-stateless"]);
    expect(resolveWolfModel(cfg, "main", sub).provider).toBe("claude-stateless");
    const api = resolveModelTable({ pack: pack(), location: "vps" });
    expect(resolveWolfModel(cfg, "fast", api).provider).toBe("anthropic");
  });

  it("a tier's provider wins over the transport; others keep the default", () => {
    const t = resolveModelTable({ pack: pack({ fast: { model: "claude-haiku-5-5", provider: "anthropic" } }), location: "local" });
    expect(t.tiers.fast.piModel).toBe("anthropic/claude-haiku-5-5");
    expect(t.tiers.fast.provider).toBe("anthropic");
    expect(t.tiers.main.piModel).toBe("claude-stateless/claude-opus-5-5");
    expect(providersInUse(t)).toEqual(["claude-stateless", "anthropic"]);
    expect(resolveWolfModel(cfg, "fast", t).provider).toBe("anthropic");
  });

  it("a table file written before per-tier providers (no piProvider) still resolves", () => {
    const old = { location: "local", transport: "subscription", transportSource: "pack", warnings: [], steps: {}, tiers: { main: { model: "claude-opus-5-5", provider: "claude-agent-sdk", piModel: "claude-stateless/claude-opus-5-5" }, smart: { model: "s", provider: "claude-agent-sdk", piModel: "claude-stateless/s" }, fast: { model: "f", provider: "claude-agent-sdk", piModel: "claude-stateless/f" } } } as never;
    expect(resolveWolfModel(cfg, "main", old)).toMatchObject({ provider: "claude-stateless", piModel: "claude-stateless/claude-opus-5-5" });
  });
});

describe("registry lifecycle", () => {
  it("dispose is idempotent", () => {
    const provider = fakeProvider();
    const m = buildWolfModels(table("claude-stateless"), { cwd: "/w", seams: bridgeSeam(() => provider) });
    m.dispose();
    m.dispose();
    expect(provider.shutdown).toHaveBeenCalledOnce();
  });
});

describe("stored provider ids resolve lookup-only", () => {
  const entry = (id: string) => (model: string) => ({ id: model, name: model, api: id, provider: id, baseUrl: id, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 });
  const lookups = { anthropic: () => [entry("anthropic")("m")], "claude-stateless": () => [entry("claude-stateless")("m")], "claude-bridge": () => [entry("claude-bridge")("m")] } as never;

  it("a stored anthropic ref on a bridge-only tier resolves, and the stub refuses to serve", async () => {
    const m = buildWolfModels(table("claude-stateless"), { cwd: "/w", seams: bridgeSeam(() => fakeProvider()), storedProviders: ["anthropic"], lookups });
    const events: any[] = [];
    for await (const e of (m.models as any).streamSimple(m.models!.getModel("anthropic", "m"), { messages: [] })) events.push(e);
    expect(events[0].error.errorMessage).toMatch(/provider anthropic is not configured for this wolf/);
  });

  it("a stored claude-bridge ref (legacy) on an api-only tier resolves WITHOUT starting the provider", () => {
    const create = vi.fn();
    const m = buildWolfModels(table("anthropic"), { cwd: "/w", seams: bridgeSeam(create), storedProviders: ["claude-bridge"], lookups });
    expect(m.models!.getModel("claude-bridge", "m")).toBeDefined();
    expect(m.models!.getProvider("anthropic")?.id).toBe("anthropic");
    expect(create).not.toHaveBeenCalled();
  });

  it("an in-use provider is never replaced by a stub; unknown stored ids are ignored; no stored extras keeps the default", () => {
    const provider = fakeProvider();
    const r = buildModelRegistry(["claude-stateless"], { cwd: "/w", seams: bridgeSeam(() => provider), storedProviders: ["claude-stateless", "mystery"], lookups });
    expect(r.models.getProvider("claude-stateless")).toBe(provider);
    expect(r.models.getProvider("mystery")).toBeUndefined();
    expect(buildWolfModels(table("anthropic"), { cwd: "/w", storedProviders: ["anthropic"] }).models).toBeUndefined();
  });

  it("storedProviderIds reads the provider ids a real den holds", async () => {
    const dir = mkdtempSync(join(tmpdir(), "den-"));
    try {
      const file = join(dir, "session.sqlite");
      expect(storedProviderIds(file)).toEqual([]);
      const reg = createModels();
      reg.setProvider(anthropicProvider());
      const h = await Harness.open(await openNodeSqliteStorage(file), { models: reg, registry: createRegistry(), env: () => new NodeExecutionEnv({ cwd: dir }) } as never, BACKGROUND_CONTEXT);
      await h.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "anthropic", modelId: "claude-sonnet-5-5" }, cwd: dir } } as never);
      await h.close(BACKGROUND_CONTEXT);
      expect(storedProviderIds(file)).toContain("anthropic");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the real model lookups list models without a query, auth probe or process", async () => {
    const { claudeStatelessModels, legacyBridgeLookupModels } = await import("../providers/claude-stateless.js");
    expect(claudeStatelessModels({ cwd: "/w", env: {} }).length).toBeGreaterThan(0);
    expect(legacyBridgeLookupModels({ cwd: "/w", env: {} })[0]).toMatchObject({ provider: "claude-bridge", api: "claude-bridge" });
  });
});
