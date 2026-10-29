import { describe, expect, it, vi } from "vitest";
import { createProvider } from "@earendil-works/pi-ai/models";
import { buildWolfModels, providersInUse } from "../wolfd/models.js";
import { NEEDS_SUBSCRIPTION_TOKEN, PROVIDER_FACTORIES } from "./index.js";
import { claudeStatelessFactory, claudeStatelessPaths } from "./claude-stateless.js";

const fakeStateless = () => {
  const provider = createProvider({ id: "claude-stateless", auth: { check: async () => "t" } as any, models: [], api: { stream: () => { throw new Error("unused"); }, streamSimple: () => { throw new Error("unused"); } } } as any);
  return { provider, forget: vi.fn(async () => {}), dispose: vi.fn() };
};
const tier = (p: string) => ({ model: "claude-sonnet-5-5", provider: p === "claude-bridge" ? "claude-agent-sdk" : p, piModel: `${p}/claude-sonnet-5-5`, piProvider: p });
const mixed = { transport: "subscription", tiers: { main: tier("claude-bridge"), smart: tier("claude-stateless"), fast: tier("claude-stateless") } } as never;

describe("claude-stateless factory", () => {
  it("is registered and needs the subscription token", () => {
    expect(PROVIDER_FACTORIES["claude-stateless"]).toBe(claudeStatelessFactory);
    expect(NEEDS_SUBSCRIPTION_TOKEN.has("claude-stateless")).toBe(true);
  });

  it("builds the provider with den paths, debug on, inline tool schemas; forget and dispose reach it", () => {
    const fake = fakeStateless();
    const create = vi.fn(() => fake as never);
    const h = claudeStatelessFactory({ cwd: "/cwd", env: { WOLF_DEN: "/den", PATH: "/bin" }, seams: { "claude-stateless": { createProvider: create, models: [] } } });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: "claude-stateless", sessionDir: "/den/claude-stateless/sessions", debug: true, debugLogPath: "/den/claude-stateless/debug.log", env: { WOLF_DEN: "/den", PATH: "/bin", ENABLE_TOOL_SEARCH: "false" } }));
    h.forget!("sess-1");
    expect(fake.forget).toHaveBeenCalledWith("sess-1");
    h.dispose!();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });

  it("falls back to cwd without WOLF_DEN; the real provider carries claude's model table under its own id", () => {
    expect(claudeStatelessPaths({ cwd: "/cwd", env: {} }).sessionDir).toBe("/cwd/claude-stateless/sessions");
    const h = claudeStatelessFactory({ cwd: "/cwd", env: { WOLF_DEN: "/tmp/never-created" } });
    const models = [...h.provider.getModels()];
    expect(models.some((m) => m.id === "claude-sonnet-5-5" && m.provider === "claude-stateless" && m.api === "claude-stateless")).toBe(true);
  });

  it("mixed config: main on claude-bridge, other tiers on claude-stateless, both resolve", () => {
    expect(providersInUse(mixed)).toEqual(["claude-bridge", "claude-stateless"]);
    const bridge = createProvider({ id: "claude-bridge", auth: { check: async () => "t" } as any, models: [], api: { stream: () => { throw new Error("x"); }, streamSimple: () => { throw new Error("x"); } } } as any);
    const bridgeProvider = Object.assign(bridge, { shutdown: vi.fn(), release: vi.fn(() => 0), liveQueries: 0 });
    const fake = fakeStateless();
    const m = buildWolfModels(mixed, { cwd: "/w", env: { WOLF_DEN: "/den" }, seams: { "claude-bridge": { createProvider: () => bridgeProvider }, "claude-stateless": { createProvider: () => fake, models: [] } } });
    expect(m.models!.getProvider("claude-bridge")).toBe(bridgeProvider);
    expect(m.models!.getProvider("claude-stateless")).toBeDefined();
    m.forget("s1");
    expect(bridgeProvider.release).toHaveBeenCalledWith("s1");
    expect(fake.forget).toHaveBeenCalledWith("s1");
    m.dispose();
    expect(bridgeProvider.shutdown).toHaveBeenCalledOnce();
    expect(fake.dispose).toHaveBeenCalledOnce();
  });
});
