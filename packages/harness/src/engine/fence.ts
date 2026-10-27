/**
 * Write fence for worktree sub-agents. A child in a worktree may only write inside it; `write` and `edit` refuse a path
 * that resolves (through `..` and symlinks) outside. The tools are shared by every conversation, so the fence is keyed
 * by the call's working directory: a call whose cwd is inside a fenced root is held to that root. Reads are not fenced.
 * `bash` cannot be fenced, only checked on a best-effort basis: a command whose text names one of the root's off-limits
 * paths (main checkout, feature worktree; realpath, `~`, `$HOME` and `${HOME}` forms) is refused. A command that builds
 * the path some other way (variables, `cd ..`, a script) gets through; the brief rewrite, the prompt section and the
 * main-checkout warning are the other layers.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

interface Fence {
  /** The root as given (not resolved through symlinks). */
  lexical: string;
  offLimits: string[];
}

const fenced = new Map<string, Fence>();

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
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
};

/** Fence a worktree: calls running in it (or below it) may only write inside it. `offLimits` are the paths bash may not name. */
export function fenceRoot(root: string, offLimits: string[] = []): void {
  fenced.set(real(root), { lexical: resolve(root), offLimits });
}

/** The worktree is gone (merged, abandoned, rolled back): its fence goes with it. */
export function unfenceRoot(root: string): void {
  fenced.delete(real(root));
  for (const [k, f] of fenced) if (f.lexical === resolve(root)) fenced.delete(k);
}

/** `p` and its realpath, each also as `~/…`, `$HOME/…` and `${HOME}/…` when under the home directory. */
export function pathVariants(p: string): string[] {
  const home = homedir();
  const out = new Set<string>();
  for (const v of [p, real(p)]) {
    out.add(v);
    if (v.startsWith(home + "/")) for (const h of ["~", "$HOME", "${HOME}"]) out.add(`${h}${v.slice(home.length)}`);
  }
  return [...out];
}

/**
 * Matches a path of `paths` (any variant) as a whole path prefix: not inside a longer name (`/a/repo-other`, `/b/a/repo`).
 * Group 1 is the character before, group 2 the path. Undefined when there is nothing to match.
 */
export function offLimitsRegex(paths: string[], except: string[] = []): RegExp | undefined {
  const skip = new Set(except);
  const froms = [...new Set(paths.flatMap(pathVariants))].filter((f) => f && f !== "/" && !skip.has(f)).sort((a, b) => b.length - a.length);
  if (froms.length === 0) return undefined;
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w./~$-])(${froms.map(esc).join("|")})(?![\\w-]|\\.\\w)/?`, "g");
}

/** The error for a bash command from `cwd` that names an off-limits path of its fence, or undefined. Best effort. */
export function bashViolation(cwd: string, command: string): string | undefined {
  const home = cwd ? real(cwd) : "";
  const hit = [...fenced].find(([r]) => home && inside(r, home));
  if (!hit) return undefined;
  const [root, f] = hit;
  // (a worktree nested under an off-limits path is not a violation)
  let text = command;
  for (const own of [...new Set([root, f.lexical])]) text = text.split(own).join("");
  const re = offLimitsRegex(f.offLimits);
  const m = re ? [...text.matchAll(re)][0] : undefined;
  if (!m) return undefined;
  return `Refused: this command names ${m[2]}, which is off-limits (the repository's main checkout or the feature worktree). Use the same path under your working copy ${root} and run it from there; never edit or commit in the main checkout.`;
}

/** The error for a write at `path` made from `cwd`, or undefined when it is allowed. */
export function fenceViolation(cwd: string, path: string): string | undefined {
  const home = cwd ? real(cwd) : "";
  const root = [...fenced.keys()].find((r) => home && inside(r, home));
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
