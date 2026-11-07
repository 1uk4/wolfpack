/**
 * The verify step of `wolfpack pr prepare`: the same steps as CI (tsc --build, vitest over the affected packages, the
 * console tests if affected). The vitest step runs through `wolfpack test` (queue and cache) so a release check does not
 * start a vitest of its own next to the other agents' runs; tsc and the console suite are unchanged.
 */
import { consoleTestCommand, toolCommand, vitestCommand, type Cmd, type Pm } from "./pm.js";
import { parseTotals, type CmdResult } from "./pr-prepare.js";

export interface Affected {
  all: boolean;
  tsProjects: string[];
  vitestPaths: string[];
  extensionsTests: boolean;
  scriptsTests: boolean;
  consoleTests: boolean;
}

export interface VerifyResult {
  ok: boolean;
  summary: string;
  /** What happened to the live tests (`test:live`, this machine only): for the PR body. */
  live: string;
}

export function verifyChanges(
  a: Affected,
  pm: Pm,
  run: (cmd: string, args: string[]) => CmdResult,
  bin?: string,
  opts: { skipLive?: boolean } = {},
): VerifyResult {
  const steps: ({ name: string } & Cmd)[] = [];
  if (a.tsProjects.length) steps.push({ name: "build+typecheck", ...toolCommand(pm, "tsc", ["--build", ...a.tsProjects]) });
  const paths = [...a.vitestPaths, ...(a.extensionsTests ? ["extensions/"] : []), ...(a.scriptsTests ? ["scripts/"] : [])];
  if (a.all) steps.push({ name: "vitest (all)", ...vitestCommand([], bin) });
  else if (paths.length) steps.push({ name: "vitest (affected)", ...vitestCommand(paths, bin) });
  if (a.consoleTests) steps.push({ name: "console tests", ...consoleTestCommand(pm) });
  // The live tests (real Claude Code login) run last, on this machine, before the PR opens; --skip-live omits them.
  const live = opts.skipLive ? "skipped (--skip-live)" : "passed on this machine";
  if (!opts.skipLive) steps.push({ name: "live tests", cmd: pm, args: ["run", "test:live"] });
  const lines: string[] = [];
  for (const s of steps) {
    const r = run(s.cmd, s.args);
    if (r.code !== 0) return { ok: false, live: s.name === "live tests" ? "failed" : "not run", summary: `${s.name} FAILED\n${(r.out + r.err).trim().split("\n").slice(-15).join("\n")}` };
    const totals = parseTotals(r.out);
    lines.push(`${s.name}: ok${totals ? ` (${totals})` : ""}`);
  }
  return { ok: true, live, summary: lines.length ? lines.join("; ") : "no affected packages" };
}
