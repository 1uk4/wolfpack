/** buildWolfModels: transport -> engine model registry. No SDK calls (provider factory is mocked). */
import { describe, expect, it, vi } from "vitest";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { ClaudeBridgeProvider } from "pi-claude-bridge/core";
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
    expect(create).toHaveBeenCalledWith({ cwd: "/w", env });
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
