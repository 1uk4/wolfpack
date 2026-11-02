/**
 * wolfpack release [component...] [--minor|--major|--version X.Y.Z] [--dry-run] [--yes]
 * Lists components changed since their last <component>/vX.Y.Z tag, with commits and a suggested version.
 * Without --dry-run: asks, then creates annotated tags at HEAD and pushes ONLY those tags (CI release.yml builds + publishes).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { c } from "../render.js";
import { formatPlan, planRelease, type Bump, type ReleaseDeps } from "../release.js";

export interface ReleaseCmdOptions {
  only: string[];
  bump?: Bump;
  version?: string;
  dryRun?: boolean;
  yes?: boolean;
  cwd?: string;
  remote?: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 }).trim();
}

export async function releaseCmd(opts: ReleaseCmdOptions): Promise<void> {
  const root = git(opts.cwd ?? process.cwd(), "rev-parse", "--show-toplevel");
  const catalog = JSON.parse(readFileSync(path.join(root, "scripts/release-components.json"), "utf8")) as Record<string, unknown>;
  const components = Object.keys(catalog).filter((k) => !k.startsWith("_"));
  const aff = (await import(pathToFileURL(path.join(root, "scripts/affected.mjs")).href)) as {
    computeAffected(changed: string[] | null, ws: unknown): { components: string[] };
    changedFiles(base: string | null, head: string, cwd: string): string[] | null;
    loadWorkspaces(root: string): unknown;
  };
  const workspaces = aff.loadWorkspaces(root);
  const head = git(root, "rev-parse", "HEAD");
  const deps: ReleaseDeps = {
    tags: () => git(root, "tag", "--list").split("\n").filter(Boolean),
    affected: (base) => aff.computeAffected(aff.changedFiles(base, head, root), workspaces).components,
    commits: (base) => git(root, "log", "--no-merges", "--format=%h %s", base ? `${base}..HEAD` : "HEAD").split("\n").filter(Boolean),
  };
  const items = planRelease({ components, only: opts.only, bump: opts.bump, version: opts.version }, deps);
  console.log(`${c.bold("release plan")} at ${head.slice(0, 7)}${opts.dryRun ? " (dry run)" : ""}\n`);
  console.log(formatPlan(items));
  if (!items.length || opts.dryRun) return;

  const dirty = git(root, "status", "--porcelain", "--untracked-files=no");
  if (dirty) console.log(c.yellow("\nnote: working tree has uncommitted changes; tags point at the committed HEAD."));
  if (!opts.yes) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question(`\nCreate and push ${items.map((i) => i.tag).join(", ")}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      console.log("aborted; nothing tagged.");
      return;
    }
  }
  for (const i of items) git(root, "tag", "-a", i.tag, "-m", `${i.component} ${i.version}`, head);
  // Only the tags, never a branch.
  git(root, "push", opts.remote ?? "origin", ...items.map((i) => `refs/tags/${i.tag}`));
  for (const i of items) console.log(`pushed ${i.tag}`);
}
