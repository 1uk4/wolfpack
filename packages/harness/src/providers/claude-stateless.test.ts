import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

  it("builds the provider with state-dir paths (not in the den), debug on; NO_TOOL_SEARCH wins over ctx.env; forget and dispose reach it", () => {
    const root = mkdtempSync(join(tmpdir(), "stateless-home-"));
    try {
      const den = join(root, "den");
      const fake = fakeStateless();
      const create = vi.fn(() => fake as never);
      const env = { WOLF_DEN: den, PATH: "/bin", ENABLE_TOOL_SEARCH: "true" };
      const h = claudeStatelessFactory({ cwd: "/cwd", env, seams: { "claude-stateless": { createProvider: create, models: [] } } });
      const state = join(root, "claude-stateless", "den");
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: "claude-stateless", sessionDir: join(state, "sessions"), debug: true, debugLogPath: join(state, "debug.log"), env: { ...env, ENABLE_TOOL_SEARCH: "false" } }));
      expect(existsSync(join(state, "sessions"))).toBe(true);
      expect(existsSync(den)).toBe(false);
      h.forget!("sess-1");
      expect(fake.forget).toHaveBeenCalledWith("sess-1");
      h.dispose!();
      expect(fake.dispose).toHaveBeenCalledOnce();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses to start without WOLF_DEN (never falls back to cwd)", () => {
    expect(() => claudeStatelessPaths({ cwd: "/cwd", env: {} })).toThrow(/WOLF_DEN/);
    expect(() => claudeStatelessFactory({ cwd: "/cwd", env: {} })).toThrow(/WOLF_DEN/);
  });

  it("warns (does not swallow) when the session dir cannot be created", () => {
    const root = mkdtempSync(join(tmpdir(), "stateless-home-"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(root, "claude-stateless"), "a file where the state dir should go");
      claudeStatelessFactory({ cwd: root, env: { WOLF_DEN: join(root, "den") }, seams: { "claude-stateless": { createProvider: () => fakeStateless() as never, models: [] } } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("cannot create"));
    } finally { warn.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });

  it("the real provider carries claude's model table under its own id", () => {
    const root = mkdtempSync(join(tmpdir(), "stateless-home-"));
    try {
      const h = claudeStatelessFactory({ cwd: root, env: { WOLF_DEN: join(root, "den") } });
      const models = [...h.provider.getModels()];
      expect(models.some((m) => m.id === "claude-sonnet-5-5" && m.provider === "claude-stateless" && m.api === "claude-stateless")).toBe(true);
      h.dispose!();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("pins the assumption: nothing on the stateless entry path reaches the bridge's skills rendering (formatSkillsForPrompt)", () => {
    const dist = join(dirname(createRequire(import.meta.url).resolve("pi-claude-bridge-stateless/stateless")), "..");
    const files = [...readdirSync(join(dist, "stateless")).map((f) => join(dist, "stateless", f)), ...["convert.js", "mcp-server.js", "usage.js"].map((f) => join(dist, f))].filter((f) => f.endsWith(".js"));
    const callers = files.filter((f) => /renderSkillsBlock|rewriteSkillsBlock|formatSkillsForPrompt/.test(readFileSync(f, "utf8")));
    expect(callers).toEqual([]);
  });

  it("mixed config: main on claude-bridge, other tiers on claude-stateless, both resolve", () => {
    expect(providersInUse(mixed)).toEqual(["claude-bridge", "claude-stateless"]);
    const bridge = createProvider({ id: "claude-bridge", auth: { check: async () => "t" } as any, models: [], api: { stream: () => { throw new Error("x"); }, streamSimple: () => { throw new Error("x"); } } } as any);
    const bridgeProvider = Object.assign(bridge, { shutdown: vi.fn(), release: vi.fn(() => 0), liveQueries: 0 });
    const home = mkdtempSync(join(tmpdir(), "stateless-home-"));
    const fake = fakeStateless();
    const m = buildWolfModels(mixed, { cwd: "/w", env: { WOLF_DEN: join(home, "den") }, seams: { "claude-bridge": { createProvider: () => bridgeProvider }, "claude-stateless": { createProvider: () => fake, models: [] } } });
    expect(m.models!.getProvider("claude-bridge")).toBe(bridgeProvider);
    expect(m.models!.getProvider("claude-stateless")).toBeDefined();
    m.forget("s1");
    expect(bridgeProvider.release).toHaveBeenCalledWith("s1");
    expect(fake.forget).toHaveBeenCalledWith("s1");
    m.dispose();
    expect(bridgeProvider.shutdown).toHaveBeenCalledOnce();
    expect(fake.dispose).toHaveBeenCalledOnce();
    rmSync(home, { recursive: true, force: true });
  });
});
