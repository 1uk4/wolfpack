import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModelTable } from "@wolfpack/engine";
import { buildHarnessBundle, withLiveMemory, type BuiltHarnessBundle } from "./bundle.js";
import { smokeCheckBundle, smokeStartBundle } from "./sync-safety.js";

describe("withLiveMemory: a VPS bundle opts durable memory in", () => {
  it("adds memory.live for a wolf with the memory extension, keeping its other memory settings", () => {
    expect(withLiveMemory(undefined, ["memory"])).toEqual({ memory: { live: true } });
    expect(withLiveMemory({ memory: { librarian: true }, telegram: { a: 1 } }, ["memory"])).toEqual({ memory: { librarian: true, live: true }, telegram: { a: 1 } });
  });
  it("leaves wolves without memory, with memory off, or with an explicit live alone", () => {
    expect(withLiveMemory(undefined, ["telegram"])).toBeUndefined();
    expect(withLiveMemory({ memory: { enabled: false } }, ["memory"])).toEqual({ memory: { enabled: false } });
    expect(withLiveMemory({ memory: { live: false } }, ["memory"])).toEqual({ memory: { live: false } });
  });
});

describe("the real harness bundle", () => {
  const table = resolveModelTable({
    pack: { main: { model: "claude-sonnet-5-5" }, smart: { model: "claude-sonnet-5-5" }, fast: { model: "claude-haiku-5-5" }, transport: { local: "api", vps: "api" } },
    location: "vps",
  });
  let built: BuiltHarnessBundle | undefined;
  afterAll(() => built && fs.rmSync(built.tmpDir, { recursive: true, force: true }));

  it("loads, STARTS (createWolfHarness in the CJS bundle), and writes memory.live to wolf.yaml", async () => {
    built = await buildHarnessBundle({ name: "smokey", role: "tester", extensions: ["memory"], models: table }, "abc123");
    expect(fs.readFileSync(built.wolfYamlPath, "utf8")).toMatch(/live: true/);
    expect((await smokeCheckBundle(built.harnessPath)).ok).toBe(true);
    const r = await smokeStartBundle(built);
    expect(r.output).toMatch(/Main agent via anthropic/);
    expect(r.ok).toBe(true);
  }, 120_000);
});

describe("the real harness bundle on subscription", () => {
  it("starts with the main agent on the claude-bridge provider (SDK resolved from the host, bridge stubbed import)", async () => {
    const table = resolveModelTable({
      pack: { main: { model: "claude-sonnet-5-5" }, smart: { model: "claude-sonnet-5-5" }, fast: { model: "claude-haiku-5-5" }, transport: { local: "subscription", vps: "subscription" } },
      location: "vps",
    });
    const built = await buildHarnessBundle({ name: "smokey", role: "tester", extensions: [], models: table }, "abc123");
    try {
      const r = await smokeStartBundle(built, { expectBridge: true });
      expect(r.output).toContain("Main agent via claude-bridge");
      expect(r.output).toContain("provider=claude-bridge");
      expect(r.ok).toBe(true);
    } finally {
      fs.rmSync(built.tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("smokeStartBundle catches a startup throw that loading does not", () => {
  it("fails when the bundle loads fine but createWolfHarness throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-start-"));
    try {
      const harnessPath = path.join(dir, "harness.cjs");
      fs.writeFileSync(harnessPath, `if (process.argv.includes("--smoke")) { console.log("ok"); process.exit(0); }
        if (process.env.WOLF_HARNESS_SMOKE === "start") { console.error("Harness failed to start: TypeError createRequire"); process.exit(1); }`);
      for (const f of ["wolf.yaml", "models.json", "AGENTS.md"]) fs.writeFileSync(path.join(dir, f), f === "wolf.yaml" ? "name: x\n" : "{}");
      const files = { harnessPath, wolfYamlPath: path.join(dir, "wolf.yaml"), modelsPath: path.join(dir, "models.json"), agentsMdPath: path.join(dir, "AGENTS.md"), tmpDir: dir };
      expect((await smokeCheckBundle(harnessPath)).ok).toBe(true);
      const r = await smokeStartBundle(files);
      expect(r.ok).toBe(false);
      expect(r.output).toContain("createRequire");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("smokeStartBundle expectBridge", () => {
  it("a silent fallback to the API key fails the smoke when the bridge is expected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-bridge-"));
    try {
      const harnessPath = path.join(dir, "harness.cjs");
      fs.writeFileSync(harnessPath, 'console.log("[harness] Main agent via API key (bridge unavailable: x)"); console.log("ok");');
      fs.writeFileSync(path.join(dir, "wolf.yaml"), "name: x\n");
      fs.writeFileSync(path.join(dir, "models.json"), "{}");
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "#");
      const files = { harnessPath, wolfYamlPath: path.join(dir, "wolf.yaml"), modelsPath: path.join(dir, "models.json"), agentsMdPath: path.join(dir, "AGENTS.md"), tmpDir: dir };
      expect((await smokeStartBundle(files)).ok).toBe(true);
      const r = await smokeStartBundle(files, { expectBridge: true });
      expect(r.ok).toBe(false);
      expect(r.output).toContain("did not start on it");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
