import { realpathSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { git, gitOk } from "./git.js";

const realpath = (p: string) => realpathSync.native(p);

export interface WorkspacesConfig {
  workspaces?: { root?: string; autosquash?: boolean };
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

/** `notes` (only when there is something to say) are for the parent: why a fold was skipped, oversized commits. */
export type MergeResult = { ok: true; notes?: string[] } | { ok: false; conflict: true; files: string[]; notes?: string[] };

/** workspaces.autosquash from a parsed wolf.yaml; default false. */
export function resolveAutosquash(config?: WorkspacesConfig | null): boolean {
  return config?.workspaces?.autosquash === true;
}

/** A task commit changing more lines than this gets a prompt to the parent (never a block). */
export const SIZE_TRIGGER_LINES = 400;

export interface MergeOptions {
  /** Fold the task branch's fixup! commits before merging (workspaces.autosquash). Default off. */
  autosquash?: boolean;
  /** Changed lines per commit above which a size note is added. Default SIZE_TRIGGER_LINES. */
  sizeTrigger?: number;
}

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
  /** Test seam: runs after the fold rebase and before the post-fold checks, so a test can tamper with the folded branch. */
  afterFold?: () => Promise<void>;
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

const FIXUP = "fixup! ";
const LEFTOVER = /^(fixup|squash|amend)! /;
const BACKUP_PREFIX = "refs/wolfpack/backup";

/**
 * Why the fixups cannot be folded, or null when every fixup! in base..HEAD targets an EARLIER commit of base..HEAD
 * (git only folds a fixup into an earlier commit). `subjects` is newest first, so the target must have a larger index.
 */
function scopeProblem(subjects: string[]): string | null {
  for (let i = 0; i < subjects.length; i++) {
    const s = subjects[i]!;
    if (!s.startsWith(FIXUP)) continue;
    let t = s;
    while (t.startsWith(FIXUP)) t = t.slice(FIXUP.length);
    const matches = (x: string) => !x.startsWith(FIXUP) && t !== "" && (x === t || x.startsWith(t));
    if (subjects.slice(i + 1).some(matches)) continue;
    if (subjects.slice(0, i).some(matches)) return `"${s}" comes before the commit it targets`;
    if (/^[0-9a-f]{7,40}$/i.test(t) || /[~^/]|^HEAD$/.test(t)) return `"${s}" targets a sha or ref, not a commit subject of this task`;
    return `"${s}" targets no commit of this task`;
  }
  return null;
}

/** True when a rebase is in progress in `dir` (its rebase-merge or rebase-apply state dir exists). */
async function rebaseInProgress(dir: string): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const p = (await git(dir, ["rev-parse", "--git-path", name])).stdout.trim();
    if (p && (await exists(resolve(dir, p)))) return true;
  }
  return false;
}

/** Delete every backup ref of `branch` (refs/wolfpack/backup/<branch>/*). */
async function pruneBackups(dir: string, branch: string): Promise<void> {
  const refs = (await gitOk(dir, ["for-each-ref", "--format=%(refname)", `${BACKUP_PREFIX}/${branch}/`])).split("\n").filter(Boolean);
  for (const ref of refs) await git(dir, ["update-ref", "-d", ref]);
}

/**
 * Fold the task's fixup! commits (once). Returns a note when it did not fold (the branch is then as it was), else null.
 * The backup ref refs/wolfpack/backup/<branch>/<ms timestamp> is written before the fold. It is deleted after a
 * restore; otherwise it stays until the merge succeeds or the child is abandoned (pruneBackups), so a merge stopped
 * on a conflict after a fold keeps it.
 */
async function foldFixups(child: Workspace, base: string, hooks: MergeHooks): Promise<string | null> {
  const log = (await gitOk(child.path, ["log", "--format=%s", `${base}..HEAD`])).split("\n").filter(Boolean);
  if (!log.some((s) => s.startsWith(FIXUP))) return null;
  const problem = scopeProblem(log);
  if (problem) return `fixup! commits not folded: ${problem}; merged unfolded.`;
  const before = await gitOk(child.path, ["rev-parse", "HEAD"]);
  const beforeTree = await gitOk(child.path, ["rev-parse", "HEAD^{tree}"]);
  const backup = `${BACKUP_PREFIX}/${child.branch}/${Date.now()}`;
  await gitOk(child.path, ["update-ref", backup, before]);
  let why: string | null = null;
  const r = await git(child.path, ["rebase", "-i", "--autosquash", base], { GIT_SEQUENCE_EDITOR: "true" });
  if (r.code !== 0) {
    if (await rebaseInProgress(child.path)) {
      why = "the fold hit a conflict";
      const abort = await git(child.path, ["rebase", "--abort"]);
      if (abort.code !== 0) {
        throw new Error(`fold of ${child.branch} failed and could not be aborted in ${child.path} (backup ref ${backup}): ${abort.stderr.trim()}`);
      }
    } else {
      why = "the fold rebase could not start";
    }
  } else {
    await hooks.afterFold?.();
    const after = (await gitOk(child.path, ["log", "--format=%s", `${base}..HEAD`])).split("\n");
    if (after.some((s) => LEFTOVER.test(s))) why = "a fixup!, squash! or amend! commit remained after the fold";
    else if ((await gitOk(child.path, ["rev-parse", "HEAD^{tree}"])) !== beforeTree) why = "the folded tree differs from the unfolded tree";
  }
  if (why) {
    await gitOk(child.path, ["reset", "--hard", backup]);
    await gitOk(child.path, ["update-ref", "-d", backup]);
    return `fixup! commits not folded: ${why}; the branch was restored and merged unfolded.`;
  }
  return null;
}

async function sizeNotes(child: Workspace, base: string, trigger: number): Promise<string[]> {
  // One log: a "commit <sha> <subject>" header per commit, then its numstat rows.
  const out = await gitOk(child.path, ["log", "--numstat", "--format=commit %H %s", `${base}..HEAD`]);
  const notes: string[] = [];
  const flush = (head: string | null, lines: number) => {
    if (!head || lines <= trigger) return;
    const sha = head.slice(0, 40);
    notes.push(`Commit ${sha.slice(0, 8)} "${head.slice(41)}" changes ${lines} lines (over ${trigger}); consider asking for it to be split.`);
  };
  let head: string | null = null;
  let lines = 0;
  for (const row of out.split("\n")) {
    if (row.startsWith("commit ")) {
      flush(head, lines);
      head = row.slice("commit ".length);
      lines = 0;
    } else if (row.includes("\t")) {
      const [a, d] = row.split("\t");
      lines += (Number(a) || 0) + (Number(d) || 0);
    }
  }
  flush(head, lines);
  return notes;
}

/**
 * Rebase the child branch onto the feature branch, fast-forward the feature branch in its
 * worktree, then remove the child's worktree and branch. On conflict the rebase is aborted and
 * both trees are left clean. A dirty child (or feature) tree, or a wrong/detached branch, is
 * refused with an error. Merges into the same feature worktree run one at a time; if the
 * fast-forward fails (the feature moved), the rebase is re-run once before giving up.
 */
export function mergeChild(child: Workspace, featureWs: Workspace, hooks: MergeHooks = {}, opts: MergeOptions = {}): Promise<MergeResult> {
  return serialised(featureWs.path, async () => {
    await assertOnBranch(child, "child");
    await assertOnBranch(featureWs, "feature");
    if (await isDirty(child.path)) {
      throw new Error(`child workspace ${child.path} has uncommitted changes; commit or abandon them before merging`);
    }
    if (await isDirty(featureWs.path)) {
      throw new Error(`feature workspace ${featureWs.path} has uncommitted changes; refusing to merge into it`);
    }
    const notes: string[] = [];
    if (opts.autosquash) {
      const base = await gitOk(child.path, ["merge-base", child.branch, featureWs.branch]);
      const foldNote = await foldFixups(child, base, hooks);
      if (foldNote) notes.push(foldNote);
      notes.push(...(await sizeNotes(child, base, opts.sizeTrigger ?? SIZE_TRIGGER_LINES)));
    }
    const extra = notes.length ? { notes } : {};
    let lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const conflict = await rebaseOnto(child, featureWs);
      if (conflict) return { ...conflict, ...extra };
      await hooks.beforeFastForward?.(attempt);
      const ff = await git(featureWs.path, ["merge", "--ff-only", child.branch]);
      if (ff.code === 0) {
        await removeWorkspace(child, true);
        await pruneBackups(featureWs.repo.mainDir, child.branch);
        return { ok: true, ...extra };
      }
      lastErr = ff.stderr.trim();
    }
    throw new Error(`could not fast-forward ${featureWs.branch} to ${child.branch} after a retry: ${lastErr}`);
  });
}

/** Discard a child: force-remove its worktree and delete its branch. */
export async function abandonChild(child: Workspace): Promise<void> {
  await removeWorkspace(child, true);
  await pruneBackups(child.repo.mainDir, child.branch);
}
