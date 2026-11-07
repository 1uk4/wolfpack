import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs
import { checkLockfiles, compareLocks, regenerateNpmLock } from "./check-lockfiles.mjs";

type Problem = { kind: string; name?: string; detail: string };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const SHA = "b2a40263e4c33d10ddf07d2fb9d8a3c96ae99b8c";
const npmLock = (pkgs: Record<string, object>) => JSON.stringify({ name: "root", lockfileVersion: 3, requires: true, packages: { "": { name: "root" }, ...pkgs } }, null, 2) + "\n";
const pnpmLock = (keys: string[]) => `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\n${keys.map((k) => `  '${k}':\n    resolution: {integrity: sha512-x}\n`).join("\n")}\nsnapshots:\n\n${keys.map((k) => `  '${k}': {}\n`).join("\n")}`;

function put(root: string, p: string, c: string) { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); }
function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "check-lockfiles-"));
  dirs.push(root);
  for (const [p, c] of Object.entries(files)) put(root, p, c);
  return root;
}
const same = (root: string) => readFileSync(join(root, "package-lock.json"), "utf8");

describe("compareLocks: pnpm-lock.yaml and package-lock.json must resolve the same versions", () => {
  it("agrees when both list the same name@version pairs", () => {
    const n = npmLock({ "node_modules/foo": { version: "1.0.0" }, "node_modules/@s/bar": { version: "2.1.0" }, "node_modules/foo/node_modules/baz": { version: "3.0.0" } });
    const p = pnpmLock(["foo@1.0.0", "@s/bar@2.1.0", "baz@3.0.0"]);
    expect(compareLocks(n, p)).toEqual([]);
  });

  it("reports a version that differs between the two locks", () => {
    const n = npmLock({ "node_modules/foo": { version: "1.0.0" } });
    const p = pnpmLock(["foo@1.0.1"]);
    const out = compareLocks(n, p) as Problem[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "version-mismatch", name: "foo" });
    expect(out[0].detail).toContain("1.0.0");
    expect(out[0].detail).toContain("1.0.1");
  });

  it("reports a package that only one lock has", () => {
    const n = npmLock({ "node_modules/foo": { version: "1.0.0" }, "node_modules/only-npm": { version: "1.0.0" } });
    const p = pnpmLock(["foo@1.0.0", "only-pnpm@2.0.0"]);
    const out = compareLocks(n, p) as Problem[];
    expect(out.map((x) => `${x.kind}:${x.name}`).sort()).toEqual(["missing-in-npm:only-pnpm", "missing-in-pnpm:only-npm"]);
  });

  it("knows the git dependency name exception: npm pi-claude-bridge-stateless is pnpm pi-claude-bridge, compared by commit", () => {
    const n = npmLock({ "node_modules/pi-claude-bridge-stateless": { name: "pi-claude-bridge", version: "0.1.0", resolved: `git+ssh://git@github.com/1uk4/pi-claude-bridge.git#${SHA}` } });
    expect(compareLocks(n, pnpmLock([`pi-claude-bridge@https://codeload.github.com/1uk4/pi-claude-bridge/tar.gz/${SHA}`]))).toEqual([]);
    const other = "c".repeat(40);
    const out = compareLocks(n, pnpmLock([`pi-claude-bridge@https://codeload.github.com/1uk4/pi-claude-bridge/tar.gz/${other}`])) as Problem[];
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "version-mismatch", name: "pi-claude-bridge-stateless" });
  });

  it("reads a pnpm-lock.yaml that starts with the packageManager env document (pnpm writes two YAML documents)", () => {
    const env = `---\nlockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    packageManagerDependencies:\n      pnpm:\n        specifier: 12.18.0\n        version: 12.18.0\n\npackages:\n\n  '@pnpm/exe@12.18.0':\n    resolution: {integrity: sha512-x}\n\n---\n`;
    const n = npmLock({ "node_modules/foo": { version: "1.0.0" } });
    expect(compareLocks(n, env + pnpmLock(["foo@1.0.0"]))).toEqual([]);
  });

  it("ignores workspace links and workspace package entries", () => {
    const n = npmLock({ "node_modules/@x/a": { resolved: "packages/a", link: true }, "packages/a": { name: "@x/a", version: "0.0.1" }, "node_modules/foo": { version: "1.0.0" } });
    expect(compareLocks(n, pnpmLock(["foo@1.0.0"]))).toEqual([]);
  });
});

describe("checkLockfiles: package-lock.json must be what npm would write for the package.json files", () => {
  const workspace = (deps: Record<string, string>) => ({
    "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }),
    "packages/a/package.json": JSON.stringify({ name: "@x/a", version: "1.0.0", dependencies: deps }),
    "packages/b/package.json": JSON.stringify({ name: "@x/b", version: "1.0.0" }),
    "pnpm-lock.yaml": pnpmLock([]),
  });

  it("passes when the lock is already what npm writes (real npm, workspace-only fixture, offline)", () => {
    const root = repo(workspace({}));
    writeFileSync(join(root, "package-lock.json"), regenerateNpmLock(root));
    expect(checkLockfiles(root)).toEqual([]);
  });

  it("fails, with a fix message, when a package.json gained a dependency and package-lock.json was not updated", () => {
    const root = repo(workspace({}));
    writeFileSync(join(root, "package-lock.json"), regenerateNpmLock(root));
    writeFileSync(join(root, "packages/a/package.json"), JSON.stringify({ name: "@x/a", version: "1.0.0", dependencies: { "@x/b": "*" } }));
    const out = checkLockfiles(root) as Problem[];
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("npm-lock-drift");
    expect(out[0].detail).toContain("npm install --package-lock-only --ignore-scripts");
    expect(out[0].detail).toContain("packages/a");
  });

  it("never rewrites the checked-in lock", () => {
    const root = repo(workspace({}));
    writeFileSync(join(root, "package-lock.json"), regenerateNpmLock(root));
    writeFileSync(join(root, "packages/a/package.json"), JSON.stringify({ name: "@x/a", version: "1.0.0", dependencies: { "@x/b": "*" } }));
    const before = same(root);
    checkLockfiles(root);
    expect(same(root)).toBe(before);
  });

  it("with an injected regenerator, also reports the version mismatch between the two locks", () => {
    const n = npmLock({ "node_modules/foo": { version: "1.0.0" } });
    const root = repo({ ...workspace({}), "package-lock.json": n, "pnpm-lock.yaml": pnpmLock(["foo@9.9.9"]) });
    const out = checkLockfiles(root, { regenerate: () => n }) as Problem[];
    expect(out.map((x) => x.kind)).toEqual(["version-mismatch"]);
  });
});
