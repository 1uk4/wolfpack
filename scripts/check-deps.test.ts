import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs
import { checkDeps } from "./check-deps.mjs";

type Missing = { pkg: string; name: string; files: string[] };
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Builds a repo in a temp dir: root package.json plus one workspace package "pkg" at packages/a. */
function repo(opts: { deps?: Record<string, string>; devDeps?: Record<string, string>; rootDev?: Record<string, string>; files: Record<string, string>; rootFiles?: Record<string, string>; pkgJson?: Record<string, unknown> }) {
  const root = mkdtempSync(join(tmpdir(), "check-deps-"));
  dirs.push(root);
  const put = (p: string, c: string) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), c); };
  put("package.json", JSON.stringify({ name: "root", workspaces: ["packages/*"], devDependencies: opts.rootDev ?? {} }));
  put("packages/a/package.json", JSON.stringify({ name: "@x/a", dependencies: opts.deps ?? {}, devDependencies: opts.devDeps ?? {}, ...opts.pkgJson }));
  for (const [p, c] of Object.entries(opts.rootFiles ?? {})) put(p, c);
  for (const [p, c] of Object.entries(opts.files)) put(`packages/a/${p}`, c);
  return root;
}
const run = (root: string) => checkDeps(root) as Missing[];

describe("check-deps", () => {
  it("reports an import the package does not declare, with the file that uses it", () => {
    const missing = run(repo({ files: { "src/a.ts": `import express from "express";\n` } }));
    expect(missing).toEqual([{ pkg: "@x/a", name: "express", files: ["packages/a/src/a.ts"] }]);
  });

  it("reports every import form: export-from, dynamic import, require, side-effect import", () => {
    const src = `export * from "one";\nconst m = await import("two");\nconst r = require("three");\nimport "four";\n`;
    const names = run(repo({ files: { "src/a.ts": src } })).map((m) => m.name).sort();
    expect(names).toEqual(["four", "one", "three", "two"]);
  });

  it("accepts declared packages from any dependency field, builtins, node:, relative paths and tsconfig aliases", () => {
    const src = [
      `import a from "dep-a";`, `import b from "dev-b";`, `import fs from "node:fs";`, `import path from "path";`,
      `import fsp from "fs/promises";`, `import c from "./c.js";`, `import d from "../d.js";`, `import e from "@/lib/e";`,
    ].join("\n");
    const root = repo({ deps: { "dep-a": "1" }, devDeps: { "dev-b": "1" }, files: { "src/a.ts": src, "tsconfig.json": `{ "compilerOptions": { "paths": { "@/*": ["./*"] } }, "include": ["**/*.ts"] }` } });
    expect(run(root)).toEqual([]);
  });

  it("strips subpaths and keeps scopes: '@s/p/sub' needs '@s/p', 'lodash/fp' needs 'lodash'", () => {
    const src = `import a from "@s/p/sub/deep";\nimport b from "lodash/fp";\n`;
    expect(run(repo({ deps: { "@s/p": "1", lodash: "1" }, files: { "src/a.ts": src } }))).toEqual([]);
    const names = run(repo({ files: { "src/a.ts": src } })).map((m) => m.name).sort();
    expect(names).toEqual(["@s/p", "lodash"]);
  });

  it("counts `import type` as a use, since pnpm needs the types package at typecheck", () => {
    const missing = run(repo({ files: { "src/a.ts": `import type { Foo } from "foo-types";\n` } }));
    expect(missing.map((m) => m.name)).toEqual(["foo-types"]);
  });

  it("ignores imports inside comments", () => {
    const src = `// import x from "line-comment";\n/* import y from "block-comment"; */\n * import z from "star";\n`;
    expect(run(repo({ files: { "src/a.ts": src } }))).toEqual([]);
  });

  it("ignores require()/import() text inside quoted strings (test fixtures)", () => {
    const src = "const b = 'require(\"in-string\")';\nconst c = \"import(\\\"in-dq\\\")\";\n";
    expect(run(repo({ files: { "src/a.ts": src } }))).toEqual([]);
  });

  it("lets test files use root devDependencies but not source files", () => {
    const root = repo({
      rootDev: { vitest: "3" },
      files: { "src/a.test.ts": `import { it } from "vitest";\n`, "src/b.ts": `import { it } from "vitest";\n` },
    });
    expect(run(root)).toEqual([{ pkg: "@x/a", name: "vitest", files: ["packages/a/src/b.ts"] }]);
  });

  it("skips dist, node_modules, .next and fixtures", () => {
    const f = Object.fromEntries(["dist", "node_modules/q", ".next", "src/fixtures"].map((d) => [`${d}/x.js`, `import "ghost";\n`]));
    expect(run(repo({ files: f }))).toEqual([]);
  });

  it("does not flag a name on the allow-list for that package dir", () => {
    const root = repo({ files: { "src/a.ts": `import x from "borrowed";\nimport y from "other";\n` } });
    const allow = { "packages/a": { borrowed: "resolved from elsewhere via createRequire" } };
    expect(checkDeps(root, allow).map((m: Missing) => m.name)).toEqual(["other"]);
  });

  it("reports an allow-list entry the package no longer imports as stale, with its reason", () => {
    const root = repo({ files: { "src/a.ts": `export const a = 1;\n` } });
    const allow = { "packages/a": { gone: "used to be borrowed" }, "packages/not-in-this-repo": { x: "other repo" } };
    expect(checkDeps(root, allow)).toEqual([{ pkg: "@x/a", name: "gone", stale: true, reason: "used to be borrowed", files: [] }]);
  });

  it("scans the repo root against the root package.json, and leaves packages/ to their own package.json", () => {
    const root = repo({
      rootDev: { turbo: "2" },
      rootFiles: { "scripts/tool.mjs": `import t from "turbo";\nimport g from "glob";\n`, "vitest.config.ts": `import { defineConfig } from "vitest/config";\n` },
      files: { "src/a.ts": `import t from "turbo";\n` },
    });
    expect(run(root)).toEqual([
      { pkg: "root", name: "glob", files: ["scripts/tool.mjs"] },
      { pkg: "root", name: "vitest", files: ["vitest.config.ts"] },
      { pkg: "@x/a", name: "turbo", files: ["packages/a/src/a.ts"] },
    ]);
  });

  it("reports resolution forms: require.resolve, import.meta.resolve, createRequire(...)(), import = require, vi.mock/doMock/importActual", () => {
    const src = [
      `const a = require.resolve("r1");`,
      `const b = import.meta.resolve("r2");`,
      `const c = createRequire(import.meta.url)("r3");`,
      `import d = require("r4");`,
      `vi.mock("r5", () => ({}));`,
      `vi.doMock("r6");`,
      `const e = await vi.importActual("r7");`,
    ].join("\n");
    const names = run(repo({ files: { "src/a.ts": src } })).map((m) => m.name).sort();
    expect(names).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
  });

  it("ignores resolution forms inside quoted strings", () => {
    const src = `const s = 'require.resolve("q1")';\nconst t = "vi.mock(\\"q2\\")";\n`;
    expect(run(repo({ files: { "src/a.ts": src } }))).toEqual([]);
  });

  it("reads multi-line imports and `export { a } from`", () => {
    const src = `import {\n  one,\n  two,\n} from "multi-line";\nexport { a, b } from "re-export";\n`;
    const names = run(repo({ files: { "src/a.ts": src } })).map((m) => m.name).sort();
    expect(names).toEqual(["multi-line", "re-export"]);
  });

  it("counts a line-leading import inside a template literal (deliberate limit: fixture source must live in a fixtures dir)", () => {
    const src = "const code = `\n  import x from \"in-template\";\n`;\n";
    expect(run(repo({ files: { "src/a.ts": src } })).map((m) => m.name)).toEqual(["in-template"]);
  });

  it("treats only the exact tsconfig alias key as an alias, not a package of similar name", () => {
    const tsconfig = `{ "compilerOptions": { "paths": { "~shared": ["./shared"] } } }`;
    const src = `import a from "~shared";\nimport b from "~shared-extra";\n`;
    const names = run(repo({ files: { "src/a.ts": src, "tsconfig.json": tsconfig } })).map((m) => m.name);
    expect(names).toEqual(["~shared-extra"]);
  });

  it("accepts peerDependencies and optionalDependencies as declared", () => {
    const src = `import a from "peer-x";\nimport b from "opt-y";\nimport c from "nope-z";\n`;
    const root = repo({ pkgJson: { peerDependencies: { "peer-x": "1" }, optionalDependencies: { "opt-y": "1" } }, files: { "src/a.ts": src } });
    expect(run(root).map((m) => m.name)).toEqual(["nope-z"]);
  });

  it("applies the test-file rule to __tests__/ directories and .spec. files", () => {
    const root = repo({
      rootDev: { vitest: "3" },
      files: { "src/__tests__/helper.ts": `import "vitest";\n`, "src/a.spec.ts": `import "vitest";\n`, "src/real.ts": `import "vitest";\n` },
    });
    expect(run(root).map((m) => m.files)).toEqual([["packages/a/src/real.ts"]]);
  });

  it("leaves a nested directory with its own package.json out of the root scan", () => {
    const root = repo({
      rootFiles: { "tools/own/package.json": `{ "name": "own" }`, "tools/own/index.ts": `import "nested-only";\n`, "tools/plain.ts": `import "plain-only";\n` },
      files: {},
    });
    expect(run(root).map((m) => m.name)).toEqual(["plain-only"]);
  });

  it("ignores a lookup that sits inside a quoted string earlier on the same line", () => {
    const src = "const a = [`const x = require.resolve(\"in-tpl\");`, 'vi.mock(\"in-sq\")'];\nconst b = \"it's\"; const c = require(\"real\");\n";
    expect(run(repo({ files: { "src/a.ts": src } })).map((m) => m.name)).toEqual(["real"]);
  });
});
