import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const engineMock = vi.hoisted(() => ({ loadQuery: vi.fn() }));
vi.mock("@wolfpack/engine", async (orig) => ({ ...(await orig<object>()), loadQuery: engineMock.loadQuery }));
import { createProvider } from "@earendil-works/pi-ai/models";
import { buildWolfModels, providersInUse } from "../wolfd/models.js";
import { NEEDS_SUBSCRIPTION_TOKEN, PROVIDER_FACTORIES } from "./index.js";
import { claudeStatelessFactory, claudeStatelessPaths, lazySdkQuery, withFreshSystemPrompt } from "./claude-stateless.js";

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

  it("a legacy claude-bridge table is served by claude-stateless only", () => {
    expect(providersInUse(mixed)).toEqual(["claude-stateless"]);
    const home = mkdtempSync(join(tmpdir(), "stateless-home-"));
    const fake = fakeStateless();
    const m = buildWolfModels(mixed, { cwd: "/w", env: { WOLF_DEN: join(home, "den") }, seams: { "claude-stateless": { createProvider: () => fake, models: [] } } });
    expect(m.models!.getProvider("claude-bridge")).toBeUndefined();
    expect(m.models!.getProvider("claude-stateless")).toBeDefined();
    m.forget("s1");
    expect(fake.forget).toHaveBeenCalledWith("s1");
    m.dispose();
    expect(fake.dispose).toHaveBeenCalledOnce();
    rmSync(home, { recursive: true, force: true });
  });
});

describe("withFreshSystemPrompt", () => {
  const run = (options: object) => {
    const seen: any[] = [];
    const out = withFreshSystemPrompt((a) => { seen.push(a); return "it"; })({ prompt: "hi", options });
    return { seen, out };
  };
  it("turns a bare string (even empty) into a custom prompt with snapshot:false and keeps other options", () => {
    const { seen, out } = run({ systemPrompt: "persona", resume: "s1", cwd: "/x" });
    expect(out).toBe("it");
    expect(seen[0]).toEqual({ prompt: "hi", options: { systemPrompt: { type: "custom", prompt: "persona", snapshot: false }, resume: "s1", cwd: "/x" } });
    expect(run({ systemPrompt: "" }).seen[0].options.systemPrompt).toEqual({ type: "custom", prompt: "", snapshot: false });
  });
  it("converts string[] and adds snapshot:false to objects lacking it; keeps an explicit snapshot", () => {
    expect(run({ systemPrompt: ["a", "b"] }).seen[0].options.systemPrompt).toEqual({ type: "custom", prompt: ["a", "b"], snapshot: false });
    expect(run({ systemPrompt: { type: "preset", preset: "claude_code", append: "x" } }).seen[0].options.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: "x", snapshot: false });
    const kept = { type: "custom", prompt: "p", snapshot: true };
    const a = { prompt: "p", options: { systemPrompt: kept } };
    const seen: any[] = [];
    withFreshSystemPrompt((x) => { seen.push(x); })(a);
    expect(seen[0]).toBe(a);
  });
  it("passes a missing systemPrompt through untouched", () => {
    const a = { prompt: "p", options: {} };
    const seen: any[] = [];
    withFreshSystemPrompt((x) => { seen.push(x); })(a);
    expect(seen[0]).toBe(a);
  });
});

describe("claudeStatelessFactory query wrapping", () => {
  const build = (seams: object) => {
    const root = mkdtempSync(join(tmpdir(), "stateless-home-"));
    const create = vi.fn(() => fakeStateless() as never);
    claudeStatelessFactory({ cwd: root, env: { WOLF_DEN: join(root, "den") }, seams: { "claude-stateless": { createProvider: create, models: [], ...seams } } });
    return { root, queryFn: (create.mock.calls as any[])[0][0].queryFn as (a: any) => any };
  };
  it("wraps an injected queryFn", () => {
    const seen: any[] = [];
    const { root, queryFn } = build({ queryFn: (a: any) => { seen.push(a); return {}; } });
    try {
      queryFn({ prompt: "p", options: { systemPrompt: "persona" } });
      expect(seen[0].options.systemPrompt).toEqual({ type: "custom", prompt: "persona", snapshot: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  const stream = (items: unknown[], close = vi.fn()) => Object.assign((async function* () { yield* items; })(), { close });
  it("with no queryFn seam (wolfd, subagents) the factory's own queryFn loads the host query and rewrites the prompt", async () => {
    const seen: any[] = [];
    engineMock.loadQuery.mockResolvedValueOnce((a: any) => { seen.push(a); return stream([1, 2]); });
    const { root, queryFn } = build({});
    try {
      const got: unknown[] = [];
      for await (const m of queryFn({ prompt: "p", options: { systemPrompt: "persona", resume: "s" } })) got.push(m);
      expect(got).toEqual([1, 2]);
      expect(seen[0]).toEqual({ prompt: "p", options: { systemPrompt: { type: "custom", prompt: "persona", snapshot: false }, resume: "s" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("a rejected load reaches the iterator and is not an unhandled rejection when close() comes first", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const failing = lazySdkQuery(async () => { throw new Error("no sdk"); });
      const closedFirst = failing({ prompt: "p", options: {} }) as any;
      closedFirst.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).not.toHaveBeenCalled();
      await expect((async () => { for await (const _ of closedFirst) { /* none */ } })()).rejects.toThrow("no sdk");
      const iterated = failing({ prompt: "p", options: {} });
      await expect((async () => { for await (const _ of iterated) { /* none */ } })()).rejects.toThrow("no sdk");
    } finally { process.off("unhandledRejection", unhandled); }
  });
  it("close() before the load resolves closes the real query once it exists; close() after closes it directly", async () => {
    let resolveLoad!: (q: (a: any) => any) => void;
    const close1 = vi.fn();
    const early = lazySdkQuery(() => new Promise((r) => { resolveLoad = r; }))({ prompt: "p", options: {} }) as any;
    early.close();
    resolveLoad(() => stream([], close1));
    await new Promise((r) => setTimeout(r, 10));
    expect(close1).toHaveBeenCalledOnce();
    const close2 = vi.fn();
    const late = lazySdkQuery(async () => () => stream([7], close2))({ prompt: "p", options: {} }) as any;
    for await (const _ of late) { /* drain */ }
    late.close();
    expect(close2).toHaveBeenCalledOnce();
  });
});
