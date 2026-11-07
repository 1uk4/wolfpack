/**
 * wolfpack test [run|related] [paths…] [-t <name>] [--no-cache]
 * Wires the config and the repo root into runTests (test-runner.ts), which holds the behaviour.
 */
import { execFileSync } from "node:child_process";
import { loadConfig } from "../config.js";
import { parseTestArgs, runTests, testSettings, USAGE } from "../test-runner.js";

export async function testCmd(argv: string[]): Promise<number> {
  if (argv.includes("--help")) {
    console.log(USAGE); // also how an agent shell learns that this install can run `test` at all
    return 0;
  }
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const { args, noCache } = parseTestArgs(argv, { cwd: process.cwd(), root });
  return runTests({ root, args, noCache, settings: testSettings(loadConfig(), process.env) });
}
