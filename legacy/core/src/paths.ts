import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Walk up from `start` until we find the wolfpack repo root (the dir that
 * contains inventory/hosts.yml). Falls back to WOLFPACK_ROOT env or cwd.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  if (process.env.WOLFPACK_ROOT) return resolve(process.env.WOLFPACK_ROOT);
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, "inventory", "hosts.yml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start);
}

export function inventoryPath(root: string = findRepoRoot()): string {
  return process.env.WOLFPACK_INVENTORY ?? join(root, "inventory", "hosts.yml");
}

export function envPath(root: string = findRepoRoot()): string {
  return join(root, ".env");
}

/** Expand a leading ~ to the user's home directory. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}
