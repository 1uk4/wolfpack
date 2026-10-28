import { describe, it, expect, vi } from "vitest";
import { selectMainModel } from "./main-model.js";

const table = (transport: "api" | "subscription") => ({
  transport,
  tiers: { main: { model: "claude-sonnet-5-5" } },
}) as never;

const fakeProvider = () => ({
  id: "claude-bridge", name: "bridge", models: [], shutdown: vi.fn(), release: vi.fn(),
}) as never;

const base = { cwd: "/tmp", loadSdkQuery: async () => () => {} };

describe("selectMainModel", () => {
  it("subscription + token → the bridge, with the resolved SDK query injected", async () => {
    const createProvider = vi.fn(() => fakeProvider());
    const query = () => {};
    const c = await selectMainModel({ ...base, loadSdkQuery: async () => query, table: table("subscription"), env: { CLAUDE_CODE_OAUTH_TOKEN: "t", ANTHROPIC_API_KEY: "k" }, createProvider });
    expect(c.via).toBe("bridge");
    expect(c.model).toEqual({ provider: "claude-bridge", modelId: "claude-sonnet-5-5" });
    expect(c.line).toBe("Main agent via Max subscription (claude-bridge)");
    expect((createProvider.mock.calls[0] as unknown[])[0]).toMatchObject({ queryFn: query });
  });

  it("api transport → anthropic, bridge never created", async () => {
    const createProvider = vi.fn(() => fakeProvider());
    const c = await selectMainModel({ ...base, table: table("api"), env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, createProvider });
    expect(c.via).toBe("api");
    expect(c.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-5-5" });
    expect(c.line).toBe("Main agent via API key (transport api)");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("subscription without a token → anthropic with the reason", async () => {
    const createProvider = vi.fn(() => fakeProvider());
    const c = await selectMainModel({ ...base, table: table("subscription"), env: {}, createProvider });
    expect(c.via).toBe("api");
    expect(c.line).toContain("no CLAUDE_CODE_OAUTH_TOKEN");
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("bridge init throws → anthropic with a warning", async () => {
    const c = await selectMainModel({ ...base, table: table("subscription"), env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, createProvider: () => { throw new Error("boom"); } });
    expect(c.via).toBe("api");
    expect(c.model.provider).toBe("anthropic");
    expect(c.warning).toContain("boom");
  });

  it("Agent SDK not loadable → anthropic with a warning", async () => {
    const c = await selectMainModel({ ...base, loadSdkQuery: async () => { throw new Error("sdk missing"); }, table: table("subscription"), env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, createProvider: () => fakeProvider() });
    expect(c.via).toBe("api");
    expect(c.warning).toContain("sdk missing");
  });
});
