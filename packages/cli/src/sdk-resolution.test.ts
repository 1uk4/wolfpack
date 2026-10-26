import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { findSdkUrl, sdkAnchors } from "../../engine/src/adapters/claude-agent-sdk.js";

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

  it("findSdkUrl returns undefined when no anchor has the SDK (hermetic)", () => {
    const empty = fs.mkdtempSync(path.join(tmp, "empty-"));
    expect(findSdkUrl("@anthropic-ai/claude-agent-sdk", [empty])).toBeUndefined();
  });

  // Skipped (visibly) when this machine has a real global SDK, which resolves legitimately.
  const hasGlobal = !!findSdkUrl("@anthropic-ai/claude-agent-sdk", [path.join(path.dirname(process.execPath), "..", "lib")]);
  it.skipIf(hasGlobal)("the load error names what it tried", () => {
    const r = run(path.join(tmp, "bare/agent"));
    expect(r).toContain("could not be loaded");
    expect(r).toContain("Tried:");
  });

  it("anchor order: argv1 → NODE_PATH → global → cwd (global beats cwd)", () => {
    const stub = (root: string, version: string) => {
      const d = path.join(root, "node_modules/@anthropic-ai/claude-agent-sdk");
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version, main: "index.js" }));
      fs.writeFileSync(path.join(d, "index.js"), `exports.version = ${JSON.stringify(version)};`);
    };
    const harness = path.join(tmp, "order/harness");
    const np = path.join(tmp, "order/np");
    const prefix = path.join(tmp, "order/prefix"); // execPath = prefix/bin/node → lib = prefix/lib
    const globalLib = path.join(prefix, "lib");
    const cwd = path.join(tmp, "order/cwd");
    for (const d of [harness, np, globalLib, cwd]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(harness, "harness.cjs"), "");
    const src = { argv1: path.join(harness, "harness.cjs"), nodePath: path.join(np, "node_modules"), execPath: path.join(prefix, "bin/node"), cwd };
    const anchors = sdkAnchors(src);
    expect(anchors).toEqual([fs.realpathSync(harness), np, path.resolve(globalLib), cwd]);

    const versionAt = (a: string[]) => {
      const url = findSdkUrl("@anthropic-ai/claude-agent-sdk", a)!;
      return JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(url).pathname), "package.json"), "utf8")).version;
    };
    stub(globalLib, "global");
    stub(cwd, "cwd");
    expect(versionAt(anchors)).toBe("global"); // not "cwd"
    stub(np, "nodepath");
    expect(versionAt(anchors)).toBe("nodepath");
    stub(harness, "harness");
    expect(versionAt(anchors)).toBe("harness");
  });
});
