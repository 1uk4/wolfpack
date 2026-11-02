import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs
import { computeAffected, loadWorkspaces } from "./affected.mjs";

const ws = loadWorkspaces(new URL("..", import.meta.url).pathname);
const run = (files: string[] | null) => computeAffected(files, ws) as { all: boolean; packages: string[]; components: string[]; tsProjects: string[]; tracer: boolean; release: boolean };

describe("affected", () => {
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
    expect(r.packages).not.toContain("@wolfpack/cli");
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
});
