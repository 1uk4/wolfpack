import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResolvedTier } from "@wolfpack/engine";
import { writePiSettings } from "./extensions.js";

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cli-pi-settings-")); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const read = () => JSON.parse(fs.readFileSync(path.join(tmp, "agent/settings.json"), "utf8"));

describe("writePiSettings model defaults", () => {
  it("writes the main tier's provider and model plus hideThinkingBlock", () => {
    const main: ResolvedTier = {
      model: "claude-sonnet-5-5", modelSource: "pack", provider: "anthropic",
      piModel: "anthropic/claude-sonnet-5-5", piProvider: "anthropic",
    };
    writePiSettings(tmp, ["memory"], main);
    const s = read();
    expect(s.defaultProvider).toBe("anthropic");
    expect(s.defaultModel).toBe("claude-sonnet-5-5");
    expect(s.hideThinkingBlock).toBe(true);
  });

  it("falls back to the default main model when no tier is given", () => {
    writePiSettings(tmp, ["memory"]);
    const s = read();
    expect(s.defaultProvider).toBe("claude-stateless");
    expect(s.defaultModel).toBe("claude-opus-5-5");
    expect(s.hideThinkingBlock).toBe(true);
  });

  it("keeps a model the wolf already configured when no tier is given", () => {
    fs.mkdirSync(path.join(tmp, "agent"));
    fs.writeFileSync(path.join(tmp, "agent/settings.json"), JSON.stringify({ defaultProvider: "openrouter", defaultModel: "x", hideThinkingBlock: false }));
    writePiSettings(tmp, ["memory"]);
    expect(read()).toMatchObject({ defaultProvider: "openrouter", defaultModel: "x", hideThinkingBlock: false });
  });
});
