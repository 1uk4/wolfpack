import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverWolves, loadWolfConfig, WolfConfigError } from "./load.js";
import { applyWolfTierOverrides, resolveWolfModel, TierResolutionError } from "./tiers.js";
import { STARTER_PACK_MODELS, resolveModelTable, type ModelTable } from "../models.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wolfconfig-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function wolf(name: string, yaml: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "wolf.yaml");
  fs.writeFileSync(file, yaml);
  return file;
}

describe("loadWolfConfig", () => {
  it("reads prompts.structuredOutput (string, false, or unset) without an unknown-field warning", () => {
    const load = (y: string) => loadWolfConfig(wolf("p", y), { home: "/h" });
    expect(load("name: p\n").config.prompts).toEqual({});
    expect(load("name: p\nprompts:\n  structuredOutput: custom\n").config.prompts.structuredOutput).toBe("custom");
    const off = load("name: p\nprompts:\n  structuredOutput: false\n");
    expect(off.config.prompts.structuredOutput).toBe(false);
    expect(off.warnings.filter((w) => w.includes("prompts"))).toEqual([]);
    // unknown nested prompts keys are ignored, not an error
    const extra = load("name: p\nprompts:\n  other: x\n  structuredOutput: custom\n");
    expect(extra.config.prompts).toEqual({ structuredOutput: "custom" });
  });

  it("warns when memory settings exist but the memory extension is not listed", () => {
    const warn = (yaml: string) => loadWolfConfig(wolf("w", yaml), { home: "/h" }).warnings.filter((w) => w.includes("memory configured but not in extensions: memory is off"));
    expect(warn("name: w\nmemory:\n  defaultDomain: x\ndomains: [x]\n")).toHaveLength(1);
    expect(warn("name: w\nsandbox: { root: /tmp/dev }\n")).toHaveLength(1);
    expect(warn("name: w\nmemory:\n  live: true\n")).toHaveLength(1);
    expect(warn("name: w\nmemory:\n  live: true\nextensions: [memory]\n")).toHaveLength(0);
    expect(warn("name: w\nmemory:\n  live: true\nextensions: [wolfpack-memory]\n")).toHaveLength(0);
    expect(warn("name: w\n")).toHaveLength(0);
  });

  it("v2 minimal: applies defaults", () => {
    const file = wolf("a", "name: a\n");
    const { config, warnings } = loadWolfConfig(file, { home: "/h" });
    expect(warnings).toEqual([]);
    expect(config.identity).toEqual({ id: "a", name: "a", domains: [] });
    expect(config.capability.tools).toEqual(["coding"]);
    expect(config.capability.workspace).toBe(path.dirname(file));
    expect(config.den).toBe(path.join(path.dirname(file), "den"));
    expect(config.serve.socket).toBe("/h/.wolfpack/run/a.sock");
    expect(config.serve.port).toBeUndefined();
  });

  it("memory.consolidation: pi's thresholds by default, overridable per key", () => {
    const d = loadWolfConfig(wolf("c1", "name: c1\n"), { home: "/h" }).config.memory.consolidation;
    expect(d).toEqual({ threshold: 20000, poolTarget: 10000, trigger: "hybrid", interval: "4h" });
    const o = loadWolfConfig(wolf("c2", "name: c2\nmemory:\n  consolidation:\n    threshold: 500\n    trigger: manual\n"), { home: "/h" }).config.memory.consolidation;
    expect(o).toEqual({ threshold: 500, poolTarget: 10000, trigger: "manual", interval: "4h" });
    expect(() => loadWolfConfig(wolf("c3", "name: c3\nmemory:\n  consolidation:\n    interval: soon\n"), { home: "/h" })).toThrow(WolfConfigError);
  });

  it("v2 full", () => {
    const file = wolf(
      "b",
      `id: xyz
name: b
domains: [personal, wolfpack]
tools: [coding]
tiers:
  fast: { model: claude-sonnet-5-5, thinking: low }
workspace: ~/Code/proj
serve:
  socket: run/b.sock
  port: 7421
`,
    );
    const { config, warnings } = loadWolfConfig(file, { home: "/h" });
    expect(warnings).toEqual([]);
    expect(config.identity).toEqual({ id: "xyz", name: "b", domains: ["personal", "wolfpack"] });
    expect(config.capability.workspace).toBe("/h/Code/proj");
    expect(config.capability.tiers?.fast).toEqual({ model: "claude-sonnet-5-5", thinking: "low" });
    expect(config.serve).toEqual({ socket: path.join(path.dirname(file), "run/b.sock"), port: 7421 });
  });

  it("legacy file parses with warnings", () => {
    const file = wolf(
      "c",
      `id: ddkyhT
name: c
runtime: pi
profile: worker
role: c
domains: [personal]
extensions: [memory, ask]
`,
    );
    const { config, warnings } = loadWolfConfig(file);
    expect(config.identity.id).toBe("ddkyhT");
    expect(config.identity.domains).toEqual(["personal"]);
    expect(config.extensions).toEqual(["memory", "ask"]);
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toMatch(/"runtime" is ignored/);
    expect(warnings.join("\n")).toMatch(/"profile"/);
    expect(warnings.join("\n")).not.toMatch(/"extensions"/);
  });

  it("broken yaml → WolfConfigError", () => {
    const file = wolf("d", "name: [unclosed\n  : :\n");
    expect(() => loadWolfConfig(file)).toThrow(WolfConfigError);
  });

  it("schema violations → WolfConfigError naming the field", () => {
    expect(() => loadWolfConfig(wolf("e", "domains: [x]\n"))).toThrow(/name/);
    expect(() => loadWolfConfig(wolf("f", "name: f\nserve: { port: 99999 }\n"))).toThrow(/serve\.port/);
  });

  it("missing file → WolfConfigError", () => {
    expect(() => loadWolfConfig(path.join(tmp, "nope.yaml"))).toThrow(WolfConfigError);
  });
});

describe("discoverWolves", () => {
  it("finds */wolf.yaml, reports broken ones, skips dirs without one", () => {
    wolf("good", "name: good\n");
    wolf("legacy", "name: legacy\nruntime: pi\n");
    wolf("bad", "name: [oops\n");
    fs.mkdirSync(path.join(tmp, "empty"));
    fs.writeFileSync(path.join(tmp, "stray.txt"), "x");
    const { wolves, errors } = discoverWolves(tmp);
    expect(wolves.map((w) => w.config.identity.name)).toEqual(["good", "legacy"]);
    expect(wolves[1].warnings).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].file).toContain(path.join("bad", "wolf.yaml"));
  });

  it("missing root yields nothing", () => {
    expect(discoverWolves(path.join(tmp, "absent"))).toEqual({ wolves: [], errors: [] });
  });
});

describe("resolveWolfModel", () => {
  const apiTable: ModelTable = resolveModelTable({
    pack: { ...STARTER_PACK_MODELS, transport: { local: "api", vps: "api" } },
    location: "local",
  });
  const cfg = (tiers?: object) => loadWolfConfig(wolf("t", `name: t\n${tiers ? "tiers: " + JSON.stringify(tiers) : ""}\n`)).config;

  it("resolves api tiers", () => {
    const r = resolveWolfModel(cfg(), "smart", apiTable);
    expect(r).toMatchObject({ tier: "smart", modelId: "claude-sonnet-5-5", transport: "api", fellBack: false, overridden: false });
    expect(r.piModel).toBe("anthropic/claude-sonnet-5-5");
  });

  it("wolf tiers override model and thinking", () => {
    const r = resolveWolfModel(cfg({ fast: { model: "claude-sonnet-5-5", thinking: "low" } }), "fast", apiTable);
    expect(r).toMatchObject({ modelId: "claude-sonnet-5-5", thinking: "low", overridden: true });
  });

  it("resolves subscription transport to the claude-bridge provider", () => {
    const sub = resolveModelTable({ pack: STARTER_PACK_MODELS, location: "local" });
    expect(sub.transport).toBe("subscription");
    expect(resolveWolfModel(cfg(), "main", sub)).toMatchObject({
      transport: "subscription",
      provider: "claude-bridge",
      piModel: "claude-bridge/claude-opus-5-5",
      modelId: "claude-opus-5-5",
      overridden: false,
    });
    const over = resolveWolfModel(cfg({ main: { model: "claude-haiku-5-5" } }), "main", sub);
    expect(over).toMatchObject({ provider: "claude-bridge", piModel: "claude-bridge/claude-haiku-5-5", overridden: true });
  });

  it("rejects unknown transports", () => {
    const bad = { ...resolveModelTable({ pack: STARTER_PACK_MODELS, location: "local" }), transport: "carrier-pigeon" } as unknown as ModelTable;
    expect(() => resolveWolfModel(cfg(), "main", bad)).toThrow(TierResolutionError);
  });

  it("reads a models.json file path", () => {
    const f = path.join(tmp, "models.json");
    fs.writeFileSync(f, JSON.stringify(apiTable));
    expect(resolveWolfModel(cfg(), "main", f).modelId).toBe("claude-opus-5-5");
  });

  it("missing tier falls back to main", () => {
    const partial = structuredClone(apiTable);
    delete (partial.tiers as Record<string, unknown>).fast;
    const r = resolveWolfModel(cfg(), "fast", partial);
    expect(r).toMatchObject({ requestedTier: "fast", tier: "main", fellBack: true, modelId: "claude-opus-5-5" });
  });

  it("unknown tier name is an error", () => {
    expect(() => resolveWolfModel(cfg(), "ultra", apiTable)).toThrow(/Unknown tier/);
  });
});

describe("applyWolfTierOverrides", () => {
  const table = (): ModelTable => resolveModelTable({ pack: STARTER_PACK_MODELS, wolf: undefined, location: "local" });
  const cfg = (tiers?: object) => ({ capability: { tools: [], workspace: "/w", ...(tiers ? { tiers } : {}) } }) as never;

  it("no overrides: the same table", () => {
    const t = table();
    expect(applyWolfTierOverrides(t, cfg())).toBe(t);
  });

  it("overrides model/thinking per tier, leaves the rest, does not mutate", () => {
    const t = table();
    const before = JSON.stringify(t);
    const out = applyWolfTierOverrides(t, cfg({ fast: { model: "m-fast", thinking: "low" } }));
    expect(out.tiers.fast.model).toBe("m-fast");
    expect(out.tiers.fast.thinking).toBe("low");
    expect(out.tiers.fast.piModel.endsWith("/m-fast")).toBe(true);
    expect(out.tiers.smart).toEqual(t.tiers.smart);
    expect(JSON.stringify(t)).toBe(before);
  });
});

