import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs
import { computeAffected, loadWorkspaces, scriptsDistImports, ROOT_CONFIG } from "./affected.mjs";

const ws = loadWorkspaces(new URL("..", import.meta.url).pathname);
const run = (files: string[] | null) => computeAffected(files, ws) as { all: boolean; packages: string[]; components: string[]; tsProjects: string[]; consoleTests: boolean; tracer: boolean; release: boolean };

describe("affected", () => {
  it("a scripts/ change builds the packages the scripts import from dist, so the scripts suite can load them", () => {
    // scripts/dev-stack-extensions.mjs loads packages/cli/dist and packages/engine/dist; CI ran scripts/ without building them
    const r = computeAffected(["scripts/auto-update.test.ts"], ws, scriptsDistImports(new URL("..", import.meta.url).pathname)) as { tsProjects: string[]; scriptsTests: boolean };
    expect(r.scriptsTests).toBe(true);
    for (const d of ["packages/cli", "packages/engine"]) expect(r.tsProjects).toContain(d);
    // no scripts suite, no extra builds
    const leaf = computeAffected(["packages/cli/src/x.ts"], ws, ["packages/engine"]) as { tsProjects: string[] };
    expect(leaf.tsProjects).not.toContain("packages/engine");
  });
  it("leaf change: only that package (and dependents, none for cli)", () => {
    const r = run(["packages/cli/src/x.ts"]);
    expect(r.packages).toEqual(["@wolfpack/cli"]);
    expect(r.components).toEqual([]);
    expect(r.tracer).toBe(false);
    expect(r.release).toBe(false);
  });
  it("shared package change marks dependents transitively and their components", () => {
    const r = run(["packages/protocol/src/x.ts"]);
    for (const p of ["@wolfpack/protocol", "@wolfpack/client", "@wolfpack/harness", "@wolfpack/hubd", "@wolfpack/workerd", "@wolfpack/console"]) expect(r.packages).toContain(p);
    // @wolfpack/kb depends on protocol and cli depends on kb, so cli is a transitive dependent
    expect(r.packages).toContain("@wolfpack/cli");
    expect(r.components.sort()).toEqual(["console", "hubd", "wolfd", "workerd"]);
    expect(r.tracer).toBe(true);
  });
  it("lockfile change marks everything and triggers release smoke", () => {
    const r = run(["package-lock.json"]);
    expect(r.all).toBe(true);
    expect(r.packages.length).toBe(ws.length);
    expect(r.components.length).toBe(4);
    expect(r.tsProjects).toEqual(["."]);
    expect(r.release).toBe(true);
  });
  it("the pnpm lockfile and workspace file mark everything affected, like package-lock.json", () => {
    for (const f of ["pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      const r = run([f]);
      expect(r.all, f).toBe(true);
      expect(r.packages.length, f).toBe(ws.length);
    }
  });
  it("workflow / root config change marks everything; unknown base marks everything", () => {
    expect(run([".github/workflows/ci.yml"]).all).toBe(true);
    expect(run(["tsconfig.json"]).all).toBe(true);
    expect(run(null).all).toBe(true);
  });
  it("docs-only change marks nothing", () => {
    const r = run(["README.md", "docs/a/b.png", "packages/kb/README.md", "docs/x.md"]);
    expect(r.all).toBe(false);
    expect(r.packages).toEqual([]);
    expect(r.components).toEqual([]);
    expect(r.tsProjects).toEqual([]);
    expect(r.tracer).toBe(false);
    expect(r.release).toBe(false);
  });
  it("release scripts trigger the release job only", () => {
    const r = run(["scripts/build-wolfd-release.sh"]);
    expect(r.release).toBe(true);
    expect(r.packages).toEqual([]);
  });
  it("a console-only change builds every package console declares or imports from dist (client, protocol, harness)", () => {
    const r = run(["apps/console/app/page.tsx"]);
    expect(r.all).toBe(false);
    expect(r.consoleTests).toBe(true);
    expect(r.tsProjects).toEqual(expect.arrayContaining(["packages/client", "packages/protocol", "packages/harness"]));
  });
  it("a hubd source change marks every runtime consumer that mints hub tokens: workerd, desktop and cli", () => {
    // desktop and cli only spawn/exercise a built hubd and declare no dependency on it; the real repo's declarations must cover them
    const r = run(["packages/hubd/src/server.ts"]);
    for (const p of ["@wolfpack/workerd", "@wolfpack/desktop", "@wolfpack/cli"]) expect(r.packages, p).toContain(p);
    expect(r.tsProjects).toEqual(expect.arrayContaining(["packages/workerd", "packages/cli"]));
  });
  it("a protocol route change marks every consumer of it, including the spawn-only ones", () => {
    const r = run(["packages/protocol/src/pairing.ts"]);
    for (const p of ["@wolfpack/hubd", "@wolfpack/workerd", "@wolfpack/desktop", "@wolfpack/cli", "@wolfpack/console"]) expect(r.packages, p).toContain(p);
  });
  it("the inputs that rerun everything are exactly the ones docs/testing.md lists", () => {
    const doc = readFileSync(new URL("../docs/testing.md", import.meta.url), "utf8");
    const section = doc.split("## What makes CI rerun everything")[1]?.split("\n## ")[0] ?? "";
    const listed = ["package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "tsconfig*.json", "vitest.config", "turbo.json", ".github/workflows/**", "scripts/affected.*"];
    expect(ROOT_CONFIG.length).toBe(listed.length);
    for (const f of listed) expect(section, f).toContain(f);
    for (const f of ["package-lock.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "tsconfig.base.json", "vitest.config.ts", "turbo.json", ".github/workflows/ci.yml", "scripts/affected.mjs"]) expect(run([f]).all, f).toBe(true);
  });
  it("no console tests, no extra build projects", () => {
    expect(run(["packages/cli/src/x.ts"]).tsProjects).toEqual(["packages/cli"]);
  });
});
