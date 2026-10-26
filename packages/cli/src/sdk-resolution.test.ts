import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * Deployed extension bundles (<den>/extensions/wolfpack-memory/index.js) have no
 * node_modules above them. The engine's claude-agent-sdk (subscription tier)
 * must still resolve — from the harness' own tree — or consolidate 502s.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const engineAdapter = path.join(repoRoot, "packages/engine/src/adapters/claude-agent-sdk.ts");

describe("engine claude-agent-sdk resolution from a deployed bundle", () => {
  let tmp: string;
  let bundle: string;
  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-res-"));
    fs.mkdirSync(path.join(tmp, "den/extensions/wolfpack-memory"), { recursive: true });
    bundle = path.join(tmp, "den/extensions/wolfpack-memory/index.js");
    // Same esbuild shape as buildHarnessBundle's extension bundling.
    await esbuild.build({
      entryPoints: [engineAdapter], outfile: bundle, bundle: true, platform: "node",
      format: "cjs", target: "node20", logLevel: "silent",
    });
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** Run loadQuery() from the bundle, launched by a harness script at `harnessDir`. */
  const run = (harnessDir: string) => {
    fs.mkdirSync(harnessDir, { recursive: true });
    const harness = path.join(harnessDir, "harness.cjs");
    fs.writeFileSync(harness, `require(${JSON.stringify(bundle)}).loadQuery()
      .then((q) => console.log("RESULT:" + q.name))
      .catch((e) => console.log("RESULT:ERR " + e.message));`);
    const cwd = path.join(tmp, "elsewhere");
    fs.mkdirSync(cwd, { recursive: true });
    const env = { ...process.env, NODE_PATH: "" };
    const out = execFileSync(process.execPath, [harness], { cwd, env, encoding: "utf8" });
    return out.split("\n").find((l) => l.startsWith("RESULT:"))!.slice(7);
  };

  it("resolves the SDK from the harness' node_modules, not the extension's location", () => {
    const harnessDir = path.join(tmp, "wolf/agent");
    const sdk = path.join(harnessDir, "node_modules/@anthropic-ai/claude-agent-sdk");
    fs.mkdirSync(sdk, { recursive: true });
    fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.0.0", main: "index.js" }));
    fs.writeFileSync(path.join(sdk, "index.js"), "exports.query = function stubQuery() {};");
    expect(run(harnessDir)).toBe("stubQuery");
  });

  it("otherwise fails with a clear error naming what it tried", () => {
    const r = run(path.join(tmp, "bare/agent"));
    // A real global install on the test machine is also a valid resolution.
    if (!r.startsWith("ERR")) return;
    expect(r).toContain("could not be loaded");
    expect(r).toContain("Tried:");
  });
});
