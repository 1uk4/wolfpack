import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { git, gitOk } from "./git.js";

const realpath = (p: string) => realpathSync.native(p);

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
  if (typeof root === "string" && root.trim() !== "") {
    const r = root.trim();
    return r === "~" ? homedir() : r.startsWith("~/") ? join(homedir(), r.slice(2)) : resolve(wolfHome, r);
  }
  return join(wolfHome, "workspaces");
}

export function branchSlug(branch: string): string {
  return branch.replace(/\//g, "-");
}

/** Throws unless the slug is safe to embed in a branch name and a path. */
export function assertSlug(slug: string, what = "slug"): void {
  if (
    !/^[a-z0-9][a-z0-9._-]*$/i.test(slug) ||
    slug.includes("..") ||
    slug.includes("--") ||
    slug.toLowerCase().endsWith(".lock")
  ) {
    throw new Error(`invalid ${what} ${JSON.stringify(slug)}: use letters, digits, ".", "_" and "-" (no "..", no "--", no trailing ".lock")`);
  }
}

export function featureBranch(featureSlug: string): string {
  assertSlug(featureSlug, "feature slug");
  return `feat/${featureSlug}`;
}

export function childBranch(featureSlug: string, childSlug: string): string {
  assertSlug(featureSlug, "feature slug");
  assertSlug(childSlug, "child slug");
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
  const toplevel = realpath(top);
  const commonDir = realpath(resolve(cwd, common));
  const mainDir = basename(commonDir) === ".git" ? dirname(commonDir) : toplevel;
  return { toplevel, name: basename(mainDir), mainDir };
}

/** Why `branch` cannot be created fresh under `root` (it, or its worktree path, already exists), or null when it is free. */
export async function workspaceConflict(opts: { root: string; repo: RepoInfo; branch: string }): Promise<string | null> {
  if (await branchExists(opts.repo.mainDir, opts.branch)) return `branch ${opts.branch} already exists in ${opts.repo.mainDir}`;
  const path = workspacePath(opts.root, opts.repo.name, opts.branch);
  if (await exists(path)) return `${path} already exists`;
  return null;
}

async function branchExists(dir: string, branch: string): Promise<boolean> {
  return (await git(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

/** Path of the worktree that has `branch` checked out, if any (a registered worktree whose directory is gone counts as missing). */
async function worktreeOf(dir: string, branch: string): Promise<string | null> {
  const out = await gitOk(dir, ["worktree", "list", "--porcelain"]);
  let path: string | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && path) {
      if (await exists(path)) return path;
      // Registered but its directory is gone: forget it so it can be recreated.
      await gitOk(dir, ["worktree", "prune"]);
      return null;
    }
  }
  return null;
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false);
}

async function ensureWorktree(repo: RepoInfo, branch: string, path: string, startPoint: string): Promise<Workspace> {
  const existing = await worktreeOf(repo.mainDir, branch);
  if (existing) return { repo, branch, path: realpath(existing) };
  if (await exists(path)) {
    throw new Error(`workspace path ${path} for ${branch} is already taken by something that is not a worktree of ${branch}`);
  }
  await mkdir(dirname(path), { recursive: true });
  if (await branchExists(repo.mainDir, branch)) {
    await gitOk(repo.mainDir, ["worktree", "add", path, branch]);
  } else {
    await gitOk(repo.mainDir, ["worktree", "add", "-b", branch, path, startPoint]);
  }
  return { repo, branch, path: realpath(path) };
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

/**
 * A child with no feature: feat/home--<slug> cut from the current HEAD of `baseDir` (a checkout of `repo`), plus its
 * worktree (idempotent). Merging it back is left to the caller.
 */
export async function createHomeChildWorkspace(opts: {
  root: string;
  repo: RepoInfo;
  childSlug: string;
  baseDir: string;
}): Promise<Workspace> {
  const branch = childBranch("home", opts.childSlug);
  const head = await gitOk(opts.baseDir, ["rev-parse", "HEAD"]);
  return ensureWorktree(opts.repo, branch, workspacePath(opts.root, opts.repo.name, branch), head);
}

async function isDirty(dir: string): Promise<boolean> {
  return (await gitOk(dir, ["status", "--porcelain"])) !== "";
}

async function removeWorkspace(ws: Workspace, force: boolean): Promise<void> {
  const rm = (f: boolean) => git(ws.repo.mainDir, ["worktree", "remove", ...(f ? ["--force"] : []), ws.path]);
  let r = await rm(false);
  if (r.code !== 0 && force) r = await rm(true);
  if (r.code !== 0) throw new Error(`git worktree remove failed for ${ws.path}: ${r.stderr.trim()}`);
  await gitOk(ws.repo.mainDir, ["branch", "-D", ws.branch]);
}

async function assertOnBranch(ws: Workspace, role: string): Promise<void> {
  const cur = (await gitOk(ws.path, ["branch", "--show-current"]));
  if (cur !== ws.branch) {
    throw new Error(`${role} workspace ${ws.path} has ${cur === "" ? "a detached HEAD" : cur} checked out, expected ${ws.branch}`);
  }
}

const mergeLocks = new Map<string, Promise<unknown>>();

/** Run fn after every earlier call with the same key has settled. */
function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mergeLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  mergeLocks.set(key, tail);
  void tail.then(() => { if (mergeLocks.get(key) === tail) mergeLocks.delete(key); });
  return run;
}

/** Test seam. */
export interface MergeHooks {
  /** Runs after the rebase succeeds and before each fast-forward attempt. */
  beforeFastForward?: (attempt: number) => Promise<void>;
}

async function rebaseOnto(child: Workspace, featureWs: Workspace): Promise<MergeResult | null> {
  const rebase = await git(child.path, ["rebase", featureWs.branch]);
  if (rebase.code === 0) return null;
  const files = (await git(child.path, ["diff", "--name-only", "-z", "--diff-filter=U"])).stdout
    .split("\0").map((s) => s.trim()).filter(Boolean);
  const abort = await git(child.path, ["rebase", "--abort"]);
  if (abort.code !== 0) {
    throw new Error(`rebase of ${child.branch} failed and could not be aborted in ${child.path}: ${abort.stderr.trim()}`);
  }
  if (files.length === 0) throw new Error(`rebase of ${child.branch} failed: ${rebase.stderr.trim()}`);
  return { ok: false, conflict: true, files };
}

/**
 * Rebase the child branch onto the feature branch, fast-forward the feature branch in its
 * worktree, then remove the child's worktree and branch. On conflict the rebase is aborted and
 * both trees are left clean. A dirty child (or feature) tree, or a wrong/detached branch, is
 * refused with an error. Merges into the same feature worktree run one at a time; if the
 * fast-forward fails (the feature moved), the rebase is re-run once before giving up.
 */
export function mergeChild(child: Workspace, featureWs: Workspace, hooks: MergeHooks = {}): Promise<MergeResult> {
  return serialised(featureWs.path, async () => {
    await assertOnBranch(child, "child");
    await assertOnBranch(featureWs, "feature");
    if (await isDirty(child.path)) {
      throw new Error(`child workspace ${child.path} has uncommitted changes; commit or abandon them before merging`);
    }
    if (await isDirty(featureWs.path)) {
      throw new Error(`feature workspace ${featureWs.path} has uncommitted changes; refusing to merge into it`);
    }
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const conflict = await rebaseOnto(child, featureWs);
      if (conflict) return conflict;
      await hooks.beforeFastForward?.(attempt);
      const ff = await git(featureWs.path, ["merge", "--ff-only", child.branch]);
      if (ff.code === 0) {
        await removeWorkspace(child, true);
        return { ok: true };
      }
      lastErr = ff.stderr.trim();
    }
    throw new Error(`could not fast-forward ${featureWs.branch} to ${child.branch} after a retry: ${lastErr}`);
  });
}

/** Discard a child: force-remove its worktree and delete its branch. */
export async function abandonChild(child: Workspace): Promise<void> {
  await removeWorkspace(child, true);
}
