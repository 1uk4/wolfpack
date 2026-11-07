// The default test selection must never collect a slow (.live. / .eval.) file. A leak is silent: the paid or slow test
// just runs in every default run. Uses `vitest list`, so nothing is executed.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const list = (...args: string[]) =>
  execFileSync(process.execPath, [join(root, "node_modules/vitest/vitest.mjs"), "list", "--filesOnly", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, WOLFPACK_LIVE: "" } })
    .split("\n").map((l) => l.trim()).filter(Boolean);
const slow = (f: string) => /\.(live|eval)\.test\./.test(f);

describe("default test selection", () => {
  it("collects no .live. or .eval. file, even when one is named explicitly", () => {
    const all = list("--project", "default");
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter(slow)).toEqual([]);
    expect(list("--project", "default", "tree-rules.eval", "wolfd.subscription.live")).toEqual([]);
  });

  it("the eval and live projects collect only their own files", () => {
    expect(list("--project", "eval").every((f) => /\.eval\.test\./.test(f))).toBe(true);
    expect(list("--project", "live").every((f) => /\.live\.test\./.test(f))).toBe(true);
    expect(list("--project", "eval").length).toBeGreaterThanOrEqual(2);
  });
});

describe("workspace test scripts", () => {
  it("every script that runs vitest selects the default project", () => {
    const pkgs = ["packages", "apps", "extensions"].flatMap((d) => (existsSync(join(root, d)) ? readdirSync(join(root, d)).map((n) => join(root, d, n, "package.json")) : [])).filter(existsSync);
    const bad = pkgs.flatMap((p) => Object.entries((JSON.parse(readFileSync(p, "utf8")).scripts ?? {}) as Record<string, string>).filter(([, c]) => /\bvitest\b/.test(c) && !/--project default\b/.test(c)).map(([k]) => `${p.replace(root, "")}: ${k}`));
    expect(bad).toEqual([]);
  });
});
