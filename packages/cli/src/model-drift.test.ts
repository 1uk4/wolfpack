import { describe, it, expect } from "vitest";
import type { PackModels } from "@wolfpack/engine";
import { checkModelDrift } from "./model-drift.js";
import { modelTableHash, resolveRemoteWolfModels } from "./models.js";
import type { CliConfig } from "./config.js";

const pack: PackModels = {
  main: { model: "claude-opus-5-5" },
  smart: { model: "claude-sonnet-5-5" },
  fast: { model: "claude-haiku-5-5" },
  transport: { local: "subscription", vps: "api" },
};
const config = { models: pack } as CliConfig;
const remote = { transport: "api", models: { fast: { thinking: "low" } } };

/** The hash a sync with `config` + `remote` would have recorded. */
const deployedHash = modelTableHash(resolveRemoteWolfModels(config, remote));

describe("checkModelDrift — deployed VPS wolf vs the table resolved now", () => {
  it("unchanged table is not stale", () => {
    expect(checkModelDrift(config, { config: remote, deployedHash })).toEqual({
      stale: false,
      currentHash: deployedHash,
    });
  });

  it("a pack tier change marks it stale", () => {
    const changed = { models: { ...pack, smart: { model: "claude-fable-5-1" } } } as CliConfig;
    const drift = checkModelDrift(changed, { config: remote, deployedHash });
    expect(drift.stale).toBe(true);
    expect(drift.reason).toMatch(/models/);
  });

  it("a wolf-level override change marks it stale", () => {
    const drift = checkModelDrift(config, {
      config: { ...remote, models: { fast: { thinking: "high" } } },
      deployedHash,
    });
    expect(drift.stale).toBe(true);
  });

  it("a pack thinking change on the main tier marks it stale", () => {
    const changed = { models: { ...pack, main: { model: "claude-opus-5-5", thinking: "high" } } } as CliConfig;
    expect(checkModelDrift(changed, { config: remote, deployedHash }).stale).toBe(true);
  });

  it("a wolf deployed without a table is stale", () => {
    const drift = checkModelDrift(config, { config: remote });
    expect(drift.stale).toBe(true);
    expect(drift.reason).toMatch(/models/);
  });

  it("a broken pack config is reported as stale, not thrown", () => {
    const drift = checkModelDrift({ models: undefined } as CliConfig, { config: remote, deployedHash });
    expect(drift.stale).toBe(true);
    expect(drift.reason).toMatch(/models/);
  });
});
