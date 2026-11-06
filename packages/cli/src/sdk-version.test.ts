import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { claudeAgentSdkVersion } from "./deployer.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("claudeAgentSdkVersion: the SDK version a deploy pins on the VPS", () => {
  it("reads the version of the SDK the engine package resolves, in any node_modules layout", () => {
    // Independent of layout: where the engine's own require lands (root-hoisted under npm, packages/engine/node_modules under pnpm).
    const entry = createRequire(path.join(repoRoot, "packages/engine/package.json")).resolve("@anthropic-ai/claude-agent-sdk");
    let dir = path.dirname(entry);
    while (path.basename(dir) !== "claude-agent-sdk") dir = path.dirname(dir);
    const expected = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version;
    expect(claudeAgentSdkVersion()).toBe(expected);
    expect(expected).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("does not need <root>/node_modules/@anthropic-ai (absent under pnpm's strict layout)", () => {
    // A repo copy whose root node_modules has no SDK, with the engine package declaring/linking its own: resolution must follow the engine.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdkver-"));
    try {
      const sdk = path.join(tmp, "packages/engine/node_modules/@anthropic-ai/claude-agent-sdk");
      fs.mkdirSync(sdk, { recursive: true });
      fs.writeFileSync(path.join(tmp, "packages/engine/package.json"), "{}");
      fs.writeFileSync(path.join(sdk, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "9.8.7", main: "index.js" }));
      fs.writeFileSync(path.join(sdk, "index.js"), "");
      expect(claudeAgentSdkVersion(tmp)).toBe("9.8.7");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
