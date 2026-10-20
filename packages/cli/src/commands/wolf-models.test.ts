import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { resolveModelTable, type PackModels } from "@wolfpack/engine";
import { modelRows, parseBridgeModels, readEnvValue, readRepoAgents } from "./wolf-models.js";
import { deepMerge, remoteModelUpdates, setTierOverride } from "./wolf-config.js";
import { defaultPackModels } from "./setup.js";
import { savePackModels } from "../config.js";

const pack: PackModels = {
  main: { model: "claude-opus-5-5" },
  smart: { model: "claude-sonnet-5-5", thinking: "medium" },
  fast: { model: "claude-haiku-5-5" },
  transport: { local: "subscription", vps: "api" },
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wolf-models-"));
}

describe("modelRows", () => {
  const table = resolveModelTable({
    pack,
    wolf: { models: { fast: { model: "claude-sonnet-5-5" }, smart: { thinking: "high" } } },
    location: "local",
  });

  it("lists main, every engine step and every agent with tier and source", () => {
    const rows = modelRows(table, [
      { name: "scout", extension: "wolfpack-subagents", model: "fast" },
      { name: "worker", extension: "wolfpack-subagents", model: "smart" },
    ]);
    const byUse = Object.fromEntries(rows.map((r) => [r.use, r]));
    expect(byUse.main).toEqual({ use: "main", tier: "main", model: "claude-opus-5-5", thinking: "—", source: "pack" });
    expect(byUse.classify).toMatchObject({ tier: "fast", model: "claude-sonnet-5-5", source: "wolf" });
    expect(byUse.produce).toMatchObject({ tier: "smart", thinking: "high", source: "model pack, thinking wolf" });
    expect(byUse["agent:scout"]).toMatchObject({ tier: "fast", model: "claude-sonnet-5-5" });
    expect(rows).toHaveLength(1 + Object.keys(table.steps).length + 2);
  });

  it("shows an agent's raw model value when it isn't a tier", () => {
    const rows = modelRows(table, [{ name: "old", extension: "x", model: "claude-bridge/claude-sonnet-4-5" }]);
    expect(rows.at(-1)).toMatchObject({ tier: "—", model: "claude-bridge/claude-sonnet-4-5 (not a tier)" });
  });
});

describe("readRepoAgents", () => {
  it("reads name and model from agent frontmatter", () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "ext-a", "agents"), { recursive: true });
    fs.mkdirSync(path.join(dir, "ext-b"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ext-a", "agents", "scout.md"), "---\nname: scout\nmodel: fast\n---\nbody\n");
    fs.writeFileSync(path.join(dir, "ext-a", "agents", "bare.md"), "no frontmatter\n");
    expect(readRepoAgents(dir)).toEqual([
      { name: "bare", extension: "ext-a", model: undefined },
      { name: "scout", extension: "ext-a", model: "fast" },
    ]);
  });

  it("finds the repo's own agent files", () => {
    expect(readRepoAgents().map((a) => a.name)).toContain("scout");
  });
});

describe("live model list helpers", () => {
  it("takes only claude-bridge rows from pi --list-models", () => {
    const out = [
      "provider       model                     context  max-out  thinking  images",
      "claude-bridge  claude-opus-5-5           1M       128K     yes       yes",
      "claude-bridge  claude-haiku-5-5          200K     128K     yes       yes",
      "openai         gpt-5                     400K     128K     yes       yes",
    ].join("\n");
    expect(parseBridgeModels(out)).toEqual(["claude-opus-5-5", "claude-haiku-5-5"]);
  });

  it("reads a key from a dotenv file", () => {
    const file = path.join(tmpDir(), ".env");
    fs.writeFileSync(file, "# c\nOTHER=1\nexport ANTHROPIC_API_KEY=\"sk-test\"\n");
    expect(readEnvValue(file, "ANTHROPIC_API_KEY")).toBe("sk-test");
    expect(readEnvValue(file, "MISSING")).toBeUndefined();
    expect(readEnvValue(path.join(tmpDir(), "nope"), "X")).toBeUndefined();
  });
});

describe("wolf override editing", () => {
  it("sets and clears tier keys, deleting empty tiers and blocks", () => {
    let m = setTierOverride(undefined, "fast", "model", "claude-sonnet-5-5");
    m = setTierOverride(m, "fast", "thinking", "low");
    expect(m).toEqual({ fast: { model: "claude-sonnet-5-5", thinking: "low" } });
    m = setTierOverride(m, "fast", "model", undefined);
    expect(m).toEqual({ fast: { thinking: "low" } });
    expect(setTierOverride(m, "fast", "thinking", undefined)).toBeUndefined();
  });

  it("sends every tier to the agent, null for cleared ones", () => {
    expect(remoteModelUpdates({ models: { fast: { model: "x" } } })).toEqual({
      transport: null,
      models: { main: null, smart: null, fast: { model: "x" } },
    });
    expect(remoteModelUpdates({ transport: "api" })).toEqual({ transport: "api", models: null });
  });

  it("deep-merges --set updates", () => {
    expect(deepMerge({ models: { fast: { model: "a", thinking: "low" } }, domains: ["x"] }, { models: { fast: { model: "b" } } }))
      .toEqual({ models: { fast: { model: "b", thinking: "low" } }, domains: ["x"] });
  });
});

describe("pack models block", () => {
  it("setup's defaults resolve without warnings", () => {
    const models = defaultPackModels();
    expect(models.transport).toEqual({ local: "subscription", vps: "api" });
    const table = resolveModelTable({ pack: models, location: "vps" });
    expect(table.warnings).toEqual([]);
    expect(table.tiers.main.model).toMatch(/^claude-opus-/);
    expect(table.tiers.smart.model).toMatch(/^claude-sonnet-/);
    expect(table.tiers.fast.model).toMatch(/^claude-haiku-/);
  });

  it("savePackModels keeps the rest of config.yaml", () => {
    const file = path.join(tmpDir(), "config.yaml");
    fs.writeFileSync(file, "# pack config\nwolvesRoot: /w\nhosts:\n  a: { address: 1.2.3.4 }\n");
    savePackModels(pack, file);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toContain("# pack config");
    expect(text).toContain("wolvesRoot: /w");
    expect(text).toContain("address: 1.2.3.4");
    expect(text).toContain("model: claude-opus-5-5");
    savePackModels(undefined, file);
    expect(fs.readFileSync(file, "utf8")).not.toContain("models:");
  });

  it("savePackModels creates a missing file", () => {
    const file = path.join(tmpDir(), "sub", "config.yaml");
    savePackModels(pack, file);
    expect(fs.readFileSync(file, "utf8")).toContain("transport:");
  });
});
