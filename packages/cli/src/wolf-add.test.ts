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

describe("wolfpack add wolf", () => {
  it("creates a local pi-durable wolf from wolf.yaml alone, with no terminal-pi agent/ dir", async () => {
    const { wolfAdd } = await import("./commands/wolf-add.js");
    await wolfAdd("newbie", { yes: true, runtime: "pi-durable", profile: "worker", extensions: ["memory"] });
    const dir = path.join(home, "wolves/local/newbie");
    const yaml = fs.readFileSync(path.join(dir, "wolf.yaml"), "utf8");
    expect(yaml).toMatch(/runtime: pi-durable/);
    expect(yaml).toMatch(/- memory/);
    expect(fs.existsSync(path.join(dir, "agent"))).toBe(false);
  });
});
