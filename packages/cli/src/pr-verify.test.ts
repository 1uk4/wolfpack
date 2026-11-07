import { describe, expect, it } from "vitest";
import { verifyChanges, type Affected } from "./pr-verify.js";
import type { CmdResult } from "./pr-prepare.js";

/** This CLI's own bin, as verify() is told it. The runner is started as `node <bin> test …`, never as `wolfpack` from PATH. */
const BIN = "/opt/cli/dist/bin/wolfpack.js";
const T = `${process.execPath} ${BIN} test`;
const none: Affected = { all: false, tsProjects: [], vitestPaths: [], extensionsTests: false, scriptsTests: false, consoleTests: false };

/** verify() against a fake `run` that records each spawn, so what is started is what is asserted. */
function harness(aff: Partial<Affected>, results: Record<string, CmdResult> = {}) {
  const spawned: string[] = [];
  const run = (cmd: string, args: string[]): CmdResult => {
    const line = [cmd, ...args].join(" ");
    spawned.push(line);
    return results[line] ?? { code: 0, out: "Test Files  2 passed (2)\n      Tests  9 passed (9)\n", err: "" };
  };
  return { spawned, verify: (pm: "pnpm" | "npm" = "pnpm", skipLive = true) => verifyChanges({ ...none, ...aff }, pm, run, BIN, { skipLive }) };
}

describe("pr verify", () => {
  it("runs the vitest step through `wolfpack test` (queue and cache), with tsc and the console test as before", () => {
    const h = harness({ tsProjects: ["packages/cli"], vitestPaths: ["packages/cli/src"], extensionsTests: true, consoleTests: true });
    const r = h.verify();
    expect(h.spawned).toEqual([
      "pnpm exec tsc --build packages/cli",
      `${T} run packages/cli/src extensions/`,
      "pnpm --filter @wolfpack/console test",
    ]);
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/build\+typecheck: ok.*vitest \(affected\): ok.*console tests: ok/);
  });

  it("a full run is `wolfpack test run` with no paths, under npm too", () => {
    const h = harness({ all: true });
    h.verify("npm");
    expect(h.spawned).toEqual([`${T} run`]);
  });

  it("never starts a `wolfpack` from PATH, whichever package manager", () => {
    for (const pm of ["pnpm", "npm"] as const) {
      const h = harness({ vitestPaths: ["packages/x/src"] });
      h.verify(pm);
      expect(h.spawned.every((l) => !/^wolfpack /.test(l))).toBe(true);
    }
  });

  it("starts no vitest of its own, whichever package manager", () => {
    for (const pm of ["pnpm", "npm"] as const) {
      const h = harness({ vitestPaths: ["packages/x/src"], scriptsTests: true });
      h.verify(pm);
      expect(h.spawned.join("\n")).not.toMatch(/vitest/);
    }
  });

  it("reports a failing test step with the tail of its output and stops there", () => {
    const h = harness(
      { vitestPaths: ["packages/cli/src"], consoleTests: true },
      { [`${T} run packages/cli/src`]: { code: 1, out: "FAIL a.test.ts\n", err: "boom\n" } },
    );
    const r = h.verify();
    expect(r).toMatchObject({ ok: false });
    expect(r.summary).toMatch(/^vitest \(affected\) FAILED\nFAIL a\.test\.ts/);
    expect(h.spawned).toEqual([`${T} run packages/cli/src`]);
  });

  it("runs the live tests last, with the package manager's script runner, and reports them", () => {
    for (const [pm, cmd] of [["pnpm", "pnpm run test:live"], ["npm", "npm run test:live"]] as const) {
      const h = harness({ vitestPaths: ["packages/x/src"] });
      const r = h.verify(pm, false);
      expect(h.spawned).toEqual([`${T} run packages/x/src`, cmd]);
      expect(r).toMatchObject({ ok: true, live: "passed on this machine" });
    }
  });

  it("runs the live tests even when nothing else is affected", () => {
    const h = harness({});
    expect(h.verify("pnpm", false).ok).toBe(true);
    expect(h.spawned).toEqual(["pnpm run test:live"]);
  });

  it("skipLive starts no live run and says it was skipped", () => {
    const h = harness({ vitestPaths: ["packages/x/src"] });
    expect(h.verify("pnpm", true)).toMatchObject({ ok: true, live: "skipped (--skip-live)" });
    expect(h.spawned.join("\n")).not.toMatch(/test:live/);
  });

  it("a failing live run fails the verify", () => {
    const h = harness({}, { "pnpm run test:live": { code: 1, out: "no Claude Code login\n", err: "" } });
    const r = h.verify("pnpm", false);
    expect(r.ok).toBe(false);
    expect(r.summary).toMatch(/^live tests FAILED\nno Claude Code login/);
  });

  it("says so when nothing is affected", () => {
    expect(harness({}).verify()).toMatchObject({ ok: true, summary: "no affected packages" });
  });
});
