/**
 * Write fence for worktree sub-agents. A child in a worktree may only write inside it; `write` and `edit` refuse a path
 * that resolves (through `..` and symlinks) outside. The tools are shared by every conversation, so the fence is keyed
 * by the call's working directory: a call whose cwd is inside a fenced root is held to that root. Reads are not fenced,
 * and neither is `bash` (its cwd is the worktree, and that is all that can be said for it).
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const fenced = new Set<string>();

function real(p: string): string {
  // The deepest existing ancestor is resolved (symlinks included); the part that does not exist yet is appended.
  const rest: string[] = [];
  let cur = resolve(p);
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    rest.unshift(cur.slice(up.length).replace(/^[\\/]+/, ""));
    cur = up;
  }
  let base = cur;
  try {
    base = realpathSync.native(cur);
  } catch {
    /* keep the lexical path */
  }
  return rest.length ? join(base, ...rest) : base;
}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) || p.startsWith(root + sep);
};

/** Fence a worktree: calls running in it (or below it) may only write inside it. */
export function fenceRoot(root: string): void {
  fenced.add(real(root));
}

export function unfenceRoot(root: string): void {
  fenced.delete(real(root));
}

/** The error for a write at `path` made from `cwd`, or undefined when it is allowed. */
export function fenceViolation(cwd: string, path: string): string | undefined {
  const home = cwd ? real(cwd) : "";
  const root = [...fenced].find((r) => home && inside(r, home));
  if (!root) return undefined;
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const target = real(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
  if (inside(root, target)) return undefined;
  return `Refused: ${path} resolves to ${target}, outside your working copy. Your allowed root is ${root}; edit and write files only there (use a path relative to it). The repository's main checkout and the feature worktree are off-limits.`;
}

interface Executable {
  name: string;
  execute: (args: never, api: never, context: never) => unknown;
}

/** `write` or `edit` that refuses paths outside a fenced root. */
export function fenceWriteTool<T extends Executable>(tool: T): T {
  const inner = tool.execute as (args: { path?: unknown }, api: { env?: { cwd?: string } }, context: unknown) => unknown;
  return {
    ...tool,
    execute: (args: { path?: unknown }, api: { env?: { cwd?: string } }, context: unknown) => {
      const cwd = api.env?.cwd;
      if (cwd && typeof args?.path === "string") {
        const refused = fenceViolation(cwd, args.path);
        if (refused) throw new Error(refused);
      }
      return inner(args, api, context);
    },
  } as unknown as T;
}
