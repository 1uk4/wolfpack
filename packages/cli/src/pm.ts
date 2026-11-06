/**
 * Which package manager runs commands in a checkout. Dev and CI use pnpm; a checkout without pnpm-lock.yaml (an old runtime
 * checkout, or the release path) is still npm. Same rule as scripts/runtime-update.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
