import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let prevHome: string | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-wolf-add-"));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  vi.resetModules();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
});

async function addWolf(): Promise<Record<string, any>> {
  const { wolfAdd } = await import("./commands/wolf-add.js");
  await wolfAdd("newbie", { yes: true, runtime: "pi-durable", profile: "worker", extensions: ["memory"] });
  return JSON.parse(fs.readFileSync(path.join(home, "wolves/local/newbie/agent/settings.json"), "utf8"));
}

describe("wolfpack add wolf: agent/settings.json", () => {
  it("is complete (existing package paths, model defaults) even with no pack models configured", async () => {
    const s = await addWolf();
    expect(s.packages.length).toBeGreaterThan(0);
    for (const p of s.packages) expect(fs.existsSync(p)).toBe(true);
    expect(s.defaultProvider).toBe("claude-stateless");
    expect(s.defaultModel).toBe("claude-opus-5-5");
  });

  it("uses the pack's main tier when one is configured", async () => {
    fs.mkdirSync(path.join(home, ".wolfpack"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".wolfpack/config.yaml"),
      "models:\n  transport: { local: api, vps: api }\n  main: { model: claude-sonnet-5-5 }\n  smart: { model: claude-sonnet-5-5 }\n  fast: { model: claude-sonnet-5-5 }\n",
    );
    const s = await addWolf();
    expect(s.defaultProvider).toBe("anthropic");
    expect(s.defaultModel).toBe("claude-sonnet-5-5");
  });
});
