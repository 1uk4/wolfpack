/**
 * Which package manager runs commands in a checkout. Dev and CI use pnpm; a checkout without pnpm-lock.yaml (an old runtime
 * checkout, or the release path) is still npm. Same rule as scripts/runtime-update.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Pm = "pnpm" | "npm";
export interface Cmd {
  cmd: string;
  args: string[];
}

export const pnpmInstalled = (): boolean => {
  const r = spawnSync("pnpm", ["--version"], { stdio: "ignore", shell: process.platform === "win32" });
  return !r.error && r.status === 0;
};

/** pnpm when the checkout has pnpm-lock.yaml and pnpm is installed; npm otherwise. */
export function detectPm(root: string, pnpmFound: () => boolean = pnpmInstalled): Pm {
  return existsSync(join(root, "pnpm-lock.yaml")) && pnpmFound() ? "pnpm" : "npm";
}

/** Run a locally installed tool (tsc, vitest). */
export function toolCommand(pm: Pm, tool: string, args: string[]): Cmd {
  return pm === "pnpm" ? { cmd: "pnpm", args: ["exec", tool, ...args] } : { cmd: "npx", args: [tool, ...args] };
}

/** This CLI's own bin (dist/bin/wolfpack.js next to dist/pm.js). */
export const OWN_BIN = join(dirname(fileURLToPath(import.meta.url)), "bin", "wolfpack.js");

/**
 * The vitest suite goes through the host's test runner (`wolfpack test`: one run at a time per host, capped, cached), the
 * same for either package manager. No paths = the whole suite. It is started as `node <this CLI's bin> test …`, never as
 * `wolfpack` from PATH: that may be another (older) install, or none.
 */
export function vitestCommand(paths: string[], bin: string = OWN_BIN): Cmd {
  return { cmd: process.execPath, args: [bin, "test", "run", ...paths] };
}

export function consoleTestCommand(pm: Pm): Cmd {
  return pm === "pnpm" ? { cmd: "pnpm", args: ["--filter", "@wolfpack/console", "test"] } : { cmd: "npm", args: ["test", "-w", "@wolfpack/console"] };
}

/** Install and build one checkout (the same commands as scripts/runtime-update.mjs). */
export function buildCommands(pm: Pm): Cmd[] {
  return pm === "pnpm"
    ? [
        { cmd: "pnpm", args: ["install", "--frozen-lockfile", "--prefer-offline"] },
        { cmd: "node", args: ["scripts/turbo.mjs", "run", "build"] },
      ]
    : [{ cmd: "npx", args: ["turbo", "run", "build"] }];
}
