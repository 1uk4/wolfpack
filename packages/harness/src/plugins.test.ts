import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAdapter } from "@wolfpack/engine";
import { loadWolfConfig } from "./config.js";
import { loadPlugins } from "./plugins.js";
import { PROVIDER_FACTORIES } from "./providers/index.js";

const dir = mkdtempSync(join(tmpdir(), "plugins-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Writes <dir>/<id>/{package.json,index.js}; `code` is the ESM entry. */
function plugin(id: string, manifest: Record<string, unknown>, code: string) {
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, "package.json"), JSON.stringify({ name: id, wolfpack: { entry: "./index.js", ...manifest } }));
  writeFileSync(join(dir, id, "index.js"), code);
}
const echo = (apiVersion = 1) => `export default { apiVersion: ${apiVersion},
  createProvider: (ctx) => ({ provider: { id: "fixture-echo", seenEnv: ctx.env } }),
  createEngineAdapter: () => ({ name: "fixture-adapter" }) };`;

describe("loadPlugins", () => {
  it("registers an enabled plug-in's provider and engine adapter, handing it only its requiredEnv", async () => {
    plugin("fixture-echo", { apiVersion: 1, requiredEnv: ["FIXTURE_TOKEN"], providers: ["fixture-echo"], engineProviders: ["fixture-echo"] }, echo());
    const env = { FIXTURE_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-secret" };
    await loadPlugins({ enabled: ["fixture-echo"], dir, env });
    const handle = PROVIDER_FACTORIES["fixture-echo"]!({ cwd: "/w", env }) as any;
    expect(handle.provider.seenEnv).toEqual({ FIXTURE_TOKEN: "tok" });
    expect(createAdapter({ provider: "fixture-echo", defaultModel: "m" } as any)).toEqual({ name: "fixture-adapter" });
  });

  it("loads a plug-in only when wolf.yaml lists it under plugins:", async () => {
    plugin("fixture-boom", { apiVersion: 1, providers: ["fixture-boom"] }, `throw new Error("imported");`);
    const enabledBy = async (yaml: string) => {
      const home = mkdtempSync(join(dir, "wolf-"));
      mkdirSync(join(home, "den"));
      writeFileSync(join(home, "wolf.yaml"), yaml);
      process.env.WOLF_DEN = join(home, "den");
      return (await loadWolfConfig()).plugins ?? [];
    };
    await expect(loadPlugins({ enabled: await enabledBy("name: w\n"), dir, env: {} })).resolves.toEqual([]);
    await expect(loadPlugins({ enabled: await enabledBy("name: w\nplugins: [fixture-boom]\n"), dir, env: {} })).rejects.toThrow("Plug-in fixture-boom failed to load (imported).");
    await expect(enabledBy("name: w\nplugins: fixture-boom\n")).rejects.toThrow("plugins must be a list");
  });

  it("refuses a plug-in whose entry or folder leads outside the plug-ins folder", async () => {
    writeFileSync(join(dir, "outside.js"), "export default { apiVersion: 1 };");
    plugin("fixture-up", { apiVersion: 1, entry: "../outside.js" }, "");
    await expect(loadPlugins({ enabled: ["fixture-up"], dir, env: {} })).rejects.toThrow("Plug-in fixture-up: entry must be inside its folder.");
    const away = mkdtempSync(join(tmpdir(), "plugins-away-"));
    try {
      writeFileSync(join(away, "package.json"), JSON.stringify({ wolfpack: { apiVersion: 1, entry: "./index.js" } }));
      writeFileSync(join(away, "index.js"), "export default { apiVersion: 1 };");
      symlinkSync(away, join(dir, "fixture-link"));
      await expect(loadPlugins({ enabled: ["fixture-link"], dir, env: {} })).rejects.toThrow("Plug-in fixture-link: its folder must be inside the plug-ins folder.");
    } finally { rmSync(away, { recursive: true, force: true }); }
    await expect(loadPlugins({ enabled: ["../x"], dir, env: {} })).rejects.toThrow("is not valid");
  });

  it("gives the engine adapter a narrowed env and no apiKey unless ANTHROPIC_API_KEY is declared", async () => {
    const code = `export default { apiVersion: 1, createEngineAdapter: (c) => ({ seen: c }) };`;
    plugin("fixture-nokey", { apiVersion: 1, requiredEnv: ["FIXTURE_TOKEN"], engineProviders: ["fixture-nokey"] }, code);
    plugin("fixture-key", { apiVersion: 1, requiredEnv: ["ANTHROPIC_API_KEY"], engineProviders: ["fixture-key"] }, code);
    const env = { FIXTURE_TOKEN: "tok", ANTHROPIC_API_KEY: "sk-secret", OTHER: "x" };
    await loadPlugins({ enabled: ["fixture-nokey", "fixture-key"], dir, env });
    const a = createAdapter({ provider: "fixture-nokey", apiKey: "sk-secret", defaultModel: "m" } as any) as any;
    expect(a.seen).toEqual({ env: { FIXTURE_TOKEN: "tok" }, config: { provider: "fixture-nokey", defaultModel: "m" } });
    const b = createAdapter({ provider: "fixture-key", apiKey: "sk-secret", defaultModel: "m" } as any) as any;
    expect(b.seen.config.apiKey).toBe("sk-secret");
  });

  it("rejects an engine adapter id that clashes with a built-in, and a provider id that is lookup-only", async () => {
    plugin("fixture-eclash", { apiVersion: 1, engineProviders: ["anthropic"] }, echo());
    await expect(loadPlugins({ enabled: ["fixture-eclash"], dir, env: {} })).rejects.toThrow('Plug-in fixture-eclash: engine adapter "anthropic" is already registered; rename the engine provider.');
    plugin("fixture-lclash", { apiVersion: 1, providers: ["claude-bridge"] }, echo());
    await expect(loadPlugins({ enabled: ["fixture-lclash"], dir, env: {} })).rejects.toThrow(/claude-bridge.*already registered/);
  });

  it("rejects a manifest whose lists are not arrays of strings", async () => {
    plugin("fixture-badlist", { apiVersion: 1, providers: "x" }, echo());
    await expect(loadPlugins({ enabled: ["fixture-badlist"], dir, env: {} })).rejects.toThrow('Plug-in fixture-badlist: "providers" in its wolfpack manifest must be an array of strings.');
  });

  it("rejects a plug-in built for another plug-in API", async () => {
    plugin("fixture-v2", { apiVersion: 2, providers: ["fixture-v2"] }, echo(2));
    await expect(loadPlugins({ enabled: ["fixture-v2"], dir, env: {} })).rejects.toThrow("Plug-in fixture-v2 was built for plug-in API 2; this Wolfpack needs 1.");
  });

  it("rejects a plug-in whose required env is missing", async () => {
    plugin("fixture-env", { apiVersion: 1, requiredEnv: ["FIXTURE_MISSING"], providers: ["fixture-env"] }, echo());
    await expect(loadPlugins({ enabled: ["fixture-env"], dir, env: {} })).rejects.toThrow("Plug-in fixture-env needs FIXTURE_MISSING; set it and restart.");
  });

  it("rejects a provider id that clashes with a built-in", async () => {
    plugin("fixture-clash", { apiVersion: 1, providers: ["claude-stateless"] }, echo());
    await expect(loadPlugins({ enabled: ["fixture-clash"], dir, env: {} })).rejects.toThrow(/claude-stateless.*already registered/);
  });
});
