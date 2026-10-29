import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveModel, DEFAULT_MAX_TOKENS, type EngineConfig } from "./config.js";
import {
  tierPiProvider,
  ENGINE_STEPS,
  ModelConfigError,
  STEP_TIERS,
  TIERS,
  engineSteps,
  isTier,
  loadModelTable,
  modelTableFingerprint,
  piModelArg,
  readModelTable,
  resolveModelTable,
  writeModelTable,
  type PackModels,
} from "./models.js";

const PACK: PackModels = {
  main: { model: "claude-opus-5-5" },
  smart: { model: "claude-sonnet-5-5" },
  fast: { model: "claude-haiku-5-5" },
  transport: { local: "subscription", vps: "api" },
};

const local = (wolf?: Parameters<typeof resolveModelTable>[0]["wolf"], pack: PackModels = PACK) =>
  resolveModelTable({ pack, wolf, location: "local" });

describe("resolveModelTable — layers and sources", () => {
  it("uses the pack for every tier when the wolf sets nothing", () => {
    const t = local();
    expect(t.tiers.main).toMatchObject({ model: "claude-opus-5-5", modelSource: "pack" });
    expect(t.tiers.smart).toMatchObject({ model: "claude-sonnet-5-5", modelSource: "pack" });
    expect(t.tiers.fast).toMatchObject({ model: "claude-haiku-5-5", modelSource: "pack" });
    expect(t.warnings).toEqual([]);
  });

  it("a wolf override wins for its tier only", () => {
    const t = local({ models: { fast: { model: "claude-sonnet-5-5" } } });
    expect(t.tiers.fast).toMatchObject({ model: "claude-sonnet-5-5", modelSource: "wolf" });
    expect(t.tiers.main).toMatchObject({ model: "claude-opus-5-5", modelSource: "pack" });
  });

  it("model and thinking layer separately", () => {
    const t = local(
      { models: { main: { thinking: "high" } } },
      { ...PACK, main: { model: "claude-opus-5-5", thinking: "low" } },
    );
    expect(t.tiers.main).toMatchObject({
      model: "claude-opus-5-5",
      modelSource: "pack",
      thinking: "high",
      thinkingSource: "wolf",
    });
  });

  it("ignores environment variables entirely", () => {
    const saved = { ...process.env };
    process.env.WOLFPACK_MODEL = "claude-opus-4-8";
    process.env.WOLFPACK_FAST_MODEL = "claude-opus-4-8";
    process.env.WOLFPACK_MAIN_MODEL = "claude-opus-4-8";
    try {
      const t = local();
      expect(TIERS.map((tier) => t.tiers[tier].model)).toEqual([
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
      ]);
    } finally {
      process.env = saved;
    }
  });
});

describe("resolveModelTable — transport and provider forms", () => {
  it("defaults by location: local = subscription, vps = api", () => {
    expect(local().transport).toBe("subscription");
    expect(resolveModelTable({ pack: PACK, location: "vps" }).transport).toBe("api");
  });

  it("wolf.yaml transport overrides the location default", () => {
    const t = resolveModelTable({ pack: PACK, wolf: { transport: "subscription" }, location: "vps" });
    expect(t).toMatchObject({ transport: "subscription", transportSource: "wolf" });
  });

  it("subscription → claude-agent-sdk engine, claude-bridge pi model, same ID", () => {
    expect(local().tiers.smart).toMatchObject({
      model: "claude-sonnet-5-5",
      provider: "claude-agent-sdk",
      piModel: "claude-bridge/claude-sonnet-5-5",
    });
  });

  it("api → anthropic engine and pi model, same ID", () => {
    expect(resolveModelTable({ pack: PACK, location: "vps" }).tiers.smart).toMatchObject({
      model: "claude-sonnet-5-5",
      provider: "anthropic",
      piModel: "anthropic/claude-sonnet-5-5",
    });
  });

  it("an invalid wolf transport warns and falls back to the pack default", () => {
    const t = local({ transport: "max" });
    expect(t).toMatchObject({ transport: "subscription", transportSource: "pack" });
    expect(t.warnings.join("\n")).toMatch(/transport "max"/);
  });
});

describe("resolveModelTable — thinking", () => {
  it("is unset by default", () => {
    expect(local().tiers.main.thinking).toBeUndefined();
    expect(piModelArg(local().tiers.main)).toBe("claude-bridge/claude-opus-5-5");
  });

  it("is appended to the pi model arg when set", () => {
    const t = local({ models: { main: { thinking: "xhigh" } } });
    expect(piModelArg(t.tiers.main)).toBe("claude-bridge/claude-opus-5-5:xhigh");
  });

  it("an unknown level warns and is ignored (falling back to the pack's level)", () => {
    const t = local(
      { models: { fast: { thinking: "turbo" } } },
      { ...PACK, fast: { model: "claude-haiku-5-5", thinking: "low" } },
    );
    expect(t.tiers.fast).toMatchObject({ thinking: "low", thinkingSource: "pack" });
    expect(t.warnings.join("\n")).toMatch(/thinking level "turbo"/);
  });

  it("flows into each engine step's config", () => {
    const t = local({ models: { fast: { thinking: "minimal" } } });
    const steps = engineSteps(t);
    expect(steps.classify).toEqual({ model: "claude-haiku-5-5", thinking: "minimal" });
    expect(steps.produce).toEqual({ model: "claude-sonnet-5-5" });
    const config: EngineConfig = { provider: "anthropic", defaultModel: "x", steps };
    expect(resolveModel(config, "contradict")).toMatchObject({ model: "claude-haiku-5-5", thinking: "minimal" });
  });
});

describe("resolveModelTable — errors and warnings", () => {
  it("throws a clear error when the pack has no models: block", () => {
    expect(() => resolveModelTable({ pack: undefined, location: "local" })).toThrow(ModelConfigError);
    expect(() => resolveModelTable({ pack: undefined, location: "local" })).toThrow(/wolfpack config/);
  });

  it("throws when a tier has no model", () => {
    const { fast: _fast, ...pack } = PACK;
    expect(() => local(undefined, pack)).toThrow(/models\.fast\.model/);
  });

  it("throws when the location's transport default is missing", () => {
    expect(() => resolveModelTable({ pack: { ...PACK, transport: { local: "subscription" } }, location: "vps" })).toThrow(
      /transport\.vps/,
    );
  });

  it("an unknown model ID warns but still resolves", () => {
    const t = local({ models: { smart: { model: "claude-sonet-5-5" } } });
    expect(t.tiers.smart.model).toBe("claude-sonet-5-5");
    expect(t.warnings.join("\n")).toMatch(/unknown model "claude-sonet-5-5"/);
  });
});

describe("tier coverage", () => {
  it("every engine step has a tier", () => {
    for (const step of ENGINE_STEPS) expect(isTier(STEP_TIERS[step])).toBe(true);
    expect(Object.keys(local().steps).sort()).toEqual([...ENGINE_STEPS].sort());
  });

  it("distill resolves to the smart tier from a config that never mentions it", () => {
    const t = local({ models: { smart: { model: "claude-opus-5-5" } } });
    expect(t.steps.distill).toEqual({ tier: "smart" });
    expect(engineSteps(t).distill.model).toBe("claude-opus-5-5");
  });

  it("workRecord is a smart step that resolves with no config edits", () => {
    expect(STEP_TIERS.workRecord).toBe("smart");
    const t = local({ models: { smart: { model: "claude-opus-5-5" } } });
    expect(t.steps.workRecord).toEqual({ tier: "smart" });
    expect(engineSteps(t).workRecord.model).toBe("claude-opus-5-5");
  });

  it("a table file written before a step existed still loads: the step falls back to its fixed tier", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "models-old-"));
    const file = path.join(dir, "models.json");
    const old = local();
    delete (old.steps as Record<string, unknown>).distill;
    writeModelTable(file, old);
    const t = readModelTable(file);
    expect(t.steps.distill).toEqual({ tier: "smart" });
    expect(engineSteps(t).distill.model).toBe("claude-sonnet-5-5");
    expect(modelTableFingerprint(t)).toBe(modelTableFingerprint(local()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("every agent file in the repo names a tier and sets no thinking", () => {
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const extDir = path.join(repo, "extensions");
    const files = fs
      .readdirSync(extDir)
      .map((ext) => path.join(extDir, ext, "agents"))
      .filter((dir) => fs.existsSync(dir))
      .flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => path.join(dir, f)));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const front = fs.readFileSync(file, "utf8").split(/^---$/m)[1] ?? "";
      const model = front.match(/^model:\s*(\S+)/m)?.[1];
      expect(isTier(model), `${path.relative(repo, file)}: model: ${model}`).toBe(true);
      expect(/^thinking:/m.test(front), `${path.relative(repo, file)} sets thinking:`).toBe(false);
    }
  });
});

describe("loadModelTable", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "models-test-"));
  const packYaml = [
    "defaultHost: x",
    "models:",
    "  main: { model: claude-opus-5-5 }",
    "  smart: { model: claude-sonnet-5-5 }",
    "  fast: { model: claude-haiku-5-5 }",
    "  transport: { local: subscription, vps: api }",
  ].join("\n");

  it("prefers the handed-over table file", () => {
    const dir = tmp();
    const file = path.join(dir, "models.json");
    const shipped = resolveModelTable({ pack: PACK, location: "vps" });
    writeModelTable(file, shipped);
    const { table, fromLaunch } = loadModelTable({ env: { WOLFPACK_MODELS_FILE: file }, packConfigFile: "/nonexistent" });
    expect(fromLaunch).toBe(true);
    expect(table).toEqual(shipped);
  });

  it("falls back to the pack config plus the wolf's wolf.yaml", () => {
    const dir = tmp();
    const packFile = path.join(dir, "config.yaml");
    fs.writeFileSync(packFile, packYaml);
    fs.mkdirSync(path.join(dir, "wolf", "den"), { recursive: true });
    fs.writeFileSync(path.join(dir, "wolf", "wolf.yaml"), "name: w\nmodels:\n  fast: { model: claude-sonnet-5-5 }\n");
    const { table, fromLaunch } = loadModelTable({
      env: { WOLF_DEN: path.join(dir, "wolf", "den") },
      packConfigFile: packFile,
    });
    expect(fromLaunch).toBe(false);
    expect(table.tiers.fast).toMatchObject({ model: "claude-sonnet-5-5", modelSource: "wolf" });
    expect(table.transport).toBe("subscription");
  });

  it("uses the models.json beside wolf.yaml when only WOLF_DEN is set (VPS CLIs)", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "den"));
    const shipped = resolveModelTable({ pack: PACK, location: "vps" });
    writeModelTable(path.join(dir, "models.json"), shipped);
    const { table, fromLaunch } = loadModelTable({ env: { WOLF_DEN: path.join(dir, "den") }, packConfigFile: "/nonexistent" });
    expect(fromLaunch).toBe(true);
    expect(table.transport).toBe("api");
  });

  it("errors clearly when the pack config has no models: block", () => {
    const dir = tmp();
    const packFile = path.join(dir, "config.yaml");
    fs.writeFileSync(packFile, "defaultHost: x\n");
    expect(() => loadModelTable({ env: {}, packConfigFile: packFile })).toThrow(ModelConfigError);
  });
});

describe("modelTableFingerprint", () => {
  it("is stable across key order and ignores warnings", () => {
    const a = local();
    const b = { ...JSON.parse(JSON.stringify(a)), warnings: ["x"] };
    expect(modelTableFingerprint(b)).toBe(modelTableFingerprint(a));
  });

  it("changes when a model changes", () => {
    expect(modelTableFingerprint(local({ models: { fast: { model: "claude-sonnet-5-5" } } }))).not.toBe(
      modelTableFingerprint(local()),
    );
  });
});

describe("resolveModel — output cap", () => {
  const cfg: EngineConfig = { provider: "anthropic", defaultModel: "m" };
  it("defaults every step to 16k output tokens", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(16_000);
    expect(resolveModel(cfg, "classify").maxTokens).toBe(16_000);
    expect(resolveModel(cfg, "produce").maxTokens).toBe(16_000);
  });
  it("still honours a step or engine override", () => {
    expect(resolveModel({ ...cfg, defaultMaxTokens: 2000 }, "classify").maxTokens).toBe(2000);
    expect(resolveModel({ ...cfg, steps: { classify: { model: "m", maxTokens: 512 } } }, "classify").maxTokens).toBe(512);
  });
});

describe("per-tier providers and engine-step tiers", () => {
  const pack = (extra: object) => ({ main: { model: "claude-opus-5-5" }, smart: { model: "claude-sonnet-5-5" }, fast: { model: "claude-haiku-5-5" }, transport: { local: "subscription", vps: "api" }, ...extra }) as never;
  it("an engine-step tier on a provider with no adapter is refused with a clear error", () => {
    for (const tier of ["smart", "fast"]) {
      expect(() => resolveModelTable({ pack: pack({ [tier]: { model: "x", provider: "openrouter" } }), location: "local" })).toThrow(/models\.(smart|fast)\.provider "openrouter" has no engine adapter/);
    }
  });
  it("claude-stateless on an engine-step tier maps to the claude-agent-sdk adapter, like claude-bridge", () => {
    const t = resolveModelTable({ pack: pack({ smart: { model: "claude-sonnet-5-5", provider: "claude-stateless" } }), location: "local" });
    expect(t.tiers.smart).toMatchObject({ provider: "claude-agent-sdk", piProvider: "claude-stateless", piModel: "claude-stateless/claude-sonnet-5-5" });
  });
  it("main may name any pi provider", () => {
    const t = resolveModelTable({ pack: pack({ main: { model: "x/y", provider: "openrouter" } }), location: "local" });
    expect(t.tiers.main.piModel).toBe("openrouter/x/y");
  });
  it("tierPiProvider prefers the tier's piModel prefix over the transport default", () => {
    expect(tierPiProvider({ transport: "subscription" }, { piModel: "anthropic/m" })).toBe("anthropic");
    expect(tierPiProvider({ transport: "api" }, { piModel: "claude-bridge/m" })).toBe("claude-bridge");
  });
});
