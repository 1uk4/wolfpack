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

export function verifyChanges(
  a: Affected,
  pm: Pm,
  run: (cmd: string, args: string[]) => CmdResult,
  bin?: string,
): { ok: boolean; summary: string } {
  const steps: ({ name: string } & Cmd)[] = [];
  if (a.tsProjects.length) steps.push({ name: "build+typecheck", ...toolCommand(pm, "tsc", ["--build", ...a.tsProjects]) });
  const paths = [...a.vitestPaths, ...(a.extensionsTests ? ["extensions/"] : []), ...(a.scriptsTests ? ["scripts/"] : [])];
  if (a.all) steps.push({ name: "vitest (all)", ...vitestCommand([], bin) });
  else if (paths.length) steps.push({ name: "vitest (affected)", ...vitestCommand(paths, bin) });
  if (a.consoleTests) steps.push({ name: "console tests", ...consoleTestCommand(pm) });
  const lines: string[] = [];
  for (const s of steps) {
    const r = run(s.cmd, s.args);
    if (r.code !== 0) return { ok: false, summary: `${s.name} FAILED\n${(r.out + r.err).trim().split("\n").slice(-15).join("\n")}` };
    const totals = parseTotals(r.out);
    lines.push(`${s.name}: ok${totals ? ` (${totals})` : ""}`);
  }
  return { ok: true, summary: lines.length ? lines.join("; ") : "no affected packages" };
}
