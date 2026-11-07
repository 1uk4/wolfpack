import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCommands, consoleTestCommand, detectPm, toolCommand } from "./pm.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const checkout = (files: string[]) => {
  const d = mkdtempSync(join(tmpdir(), "pm-"));
  dirs.push(d);
  for (const f of files) writeFileSync(join(d, f), "");
  return d;
};

describe("detectPm: pnpm only for a checkout that has pnpm-lock.yaml, when pnpm is installed", () => {
  it("pnpm-lock.yaml + pnpm found -> pnpm", () => expect(detectPm(checkout(["pnpm-lock.yaml"]), () => true)).toBe("pnpm"));
  it("pnpm-lock.yaml but no pnpm -> npm", () => expect(detectPm(checkout(["pnpm-lock.yaml"]), () => false)).toBe("npm"));
  it("an npm checkout stays npm even where pnpm is installed", () => expect(detectPm(checkout(["package-lock.json"]), () => true)).toBe("npm"));
});

describe("commands per package manager", () => {
  it("runs a local tool with pnpm exec, or npx on an npm checkout", () => {
    expect(toolCommand("pnpm", "vitest", ["run", "a"])).toEqual({ cmd: "pnpm", args: ["exec", "vitest", "run", "a"] });
    expect(toolCommand("npm", "vitest", ["run", "a"])).toEqual({ cmd: "npx", args: ["vitest", "run", "a"] });
  });
  it("console tests: pnpm --filter, or npm -w", () => {
    expect(consoleTestCommand("pnpm")).toEqual({ cmd: "pnpm", args: ["--filter", "@wolfpack/console", "test"] });
    expect(consoleTestCommand("npm")).toEqual({ cmd: "npm", args: ["test", "-w", "@wolfpack/console"] });
  });
  it("build: frozen install + the shared-cache turbo wrapper, or the old npx turbo", () => {
    expect(buildCommands("pnpm")).toEqual([
      { cmd: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"] },
      { cmd: "node", args: ["scripts/turbo.mjs", "run", "build"] },
    ]);
    expect(buildCommands("npm")).toEqual([{ cmd: "npx", args: ["turbo", "run", "build"] }]);
  });
});
