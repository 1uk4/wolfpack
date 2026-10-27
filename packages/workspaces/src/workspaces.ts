import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { git, gitOk } from "./git.js";

export interface WorkspacesConfig {
  workspaces?: { root?: string };
}

export interface RepoInfo {
  /** Git toplevel of the checkout the caller is in. */
  toplevel: string;
  /** Name of the main repository (stable even when cwd is inside a linked worktree). */
  name: string;
  /** Working dir of the main checkout. */
  mainDir: string;
}

export interface Workspace {
  repo: RepoInfo;
  branch: string;
  path: string;
}

export type MergeResult = { ok: true } | { ok: false; conflict: true; files: string[] };

/** workspaces.root from a parsed wolf.yaml, else <wolfHome>/workspaces. */
export function resolveWorkspacesRoot(wolfHome: string, config?: WorkspacesConfig | null): string {
  const root = config?.workspaces?.root;
  if (typeof root === "string" && root.trim() !== "") return resolve(wolfHome, root.trim());
  return join(wolfHome, "workspaces");
}

export function branchSlug(branch: string): string {
  return branch.replace(/\//g, "-");
}

export function featureBranch(featureSlug: string): string {
  return `feat/${featureSlug}`;
}

export function childBranch(featureSlug: string, childSlug: string): string {
  return `feat/${featureSlug}--${childSlug}`;
}

/** <root>/<repo>/<branch-slug> */
export function workspacePath(root: string, repoName: string, branch: string): string {
  return join(root, repoName, branchSlug(branch));
}

/** The repo containing cwd, or null when it is not in a git repo. */
export async function repoOf(cwd: string): Promise<RepoInfo | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
  if (r.code !== 0) return null;
  const [top, common] = r.stdout.split("\n").map((s) => s.trim());
  if (!top || !common) return null;
  const toplevel = realpathSync(top);
  const commonDir = realpathSync(resolve(cwd, common));
  const mainDir = basename(commonDir) === ".git" ? dirname(commonDir) : toplevel;
  return { toplevel, name: basename(mainDir), mainDir };
}

async function branchExists(dir: string, branch: string): Promise<boolean> {
  return (await git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

/** Path of the worktree that has `branch` checked out, if any. */
async function worktreeOf(dir: string, branch: string): Promise<string | null> {
  const out = await gitOk(dir, ["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path) return path;
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function ensureWorktree(repo: RepoInfo, branch: string, path: string, startPoint: string): Promise<Workspace> {
  const existing = await worktreeOf(repo.mainDir, branch);
  if (existing) return { repo, branch, path: existing };
  if (await exists(path)) throw new Error(`workspace path ${path} exists but is not a worktree of ${branch}`);
  await mkdir(dirname(path), { recursive: true });
  if (await branchExists(repo.mainDir, branch)) {
    await gitOk(repo.mainDir, ["worktree", "add", path, branch]);
  } else {
    await gitOk(repo.mainDir, ["worktree", "add", "-b", branch, path, startPoint]);
  }
  return { repo, branch, path: realpathSync(path) };
}

/**
 * Create feat/<featureSlug> (cut from the current HEAD of `baseDir`) and its worktree, if missing.
 * Idempotent: an existing branch/worktree is returned as is.
 */
export async function ensureFeatureWorkspace(opts: {
  root: string;
  repo: RepoInfo;
  featureSlug: string;
  baseDir: string;
}): Promise<Workspace> {
  const branch = featureBranch(opts.featureSlug);
  const head = await gitOk(opts.baseDir, ["rev-parse", "HEAD"]);
  return ensureWorktree(opts.repo, branch, workspacePath(opts.root, opts.repo.name, branch), head);
}

/** Create feat/<slug>--<child> cut from the feature branch, plus its worktree (idempotent). */
export async function createChildWorkspace(opts: {
  root: string;
  featureWs: Workspace;
  featureSlug: string;
  childSlug: string;
}): Promise<Workspace> {
  const { featureWs } = opts;
  const branch = childBranch(opts.featureSlug, opts.childSlug);
  return ensureWorktree(featureWs.repo, branch, workspacePath(opts.root, featureWs.repo.name, branch), featureWs.branch);
}

async function isDirty(dir: string): Promise<boolean> {
  return (await gitOk(dir, ["status", "--porcelain"])) !== "";
}

async function removeWorkspace(ws: Workspace, force: boolean): Promise<void> {
  const args = ["worktree", "remove", ...(force ? ["--force"] : []), ws.path];
  await gitOk(ws.repo.mainDir, args);
  await gitOk(ws.repo.mainDir, ["branch", "-D", ws.branch]);
}

/**
 * Rebase the child branch onto the feature branch, fast-forward the feature branch in its
 * worktree, then remove the child's worktree and branch. On conflict the rebase is aborted and
 * both trees are left clean. A dirty child (or feature) tree is refused with an error.
 */
export async function mergeChild(child: Workspace, featureWs: Workspace): Promise<MergeResult> {
  if (await isDirty(child.path)) {
    throw new Error(`child workspace ${child.path} has uncommitted changes; commit or abandon them before merging`);
  }
  if (await isDirty(featureWs.path)) {
    throw new Error(`feature workspace ${featureWs.path} has uncommitted changes; refusing to merge into it`);
  }
  const rebase = await git(child.path, ["rebase", featureWs.branch]);
  if (rebase.code !== 0) {
    const files = (await git(child.path, ["diff", "--name-only", "--diff-filter=U"])).stdout
      .split("\n").map((s) => s.trim()).filter(Boolean);
    await git(child.path, ["rebase", "--abort"]);
    if (files.length === 0) throw new Error(`rebase of ${child.branch} failed: ${rebase.stderr.trim()}`);
    return { ok: false, conflict: true, files };
  }
  await gitOk(featureWs.path, ["merge", "--ff-only", child.branch]);
  await removeWorkspace(child, true);
  return { ok: true };
}

/** Discard a child: force-remove its worktree and delete its branch. */
export async function abandonChild(child: Workspace): Promise<void> {
  await removeWorkspace(child, true);
}
