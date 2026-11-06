/**
 * `wolfpack pr post-merge`: bookkeeping after the owner has merged a release PR into `stable` on GitHub.
 * It fetches, fast-forwards the stable worktree and the current wolf's worktree, archives and cleans up merged feature branches, and rebuilds.
 * It never merges a PR, never pushes, never rebases and never forces anything: the only merge it runs is
 * `git merge --ff-only origin/stable`, and branches go with `git branch -d`, never `-D`.
 * It moves only `stable` and the branch of the worktree it is run from (when that is a `wolf/<name>` branch): other wolves'
 * branches are never touched. A feature branch is cleaned up only with proof it was merged.
 * Git and the build are injected (PostMergeDeps) so the orchestration is tested against fakes.
 */
import { hasRealChanges, PrRefusal, type CmdResult } from "./pr-prepare.js";

export interface PostMergeDeps {
  /** Runs git in `cwd` (default: the current worktree); never throws, reports the exit code. */
  git(args: string[], cwd?: string): CmdResult;
  /** `npx turbo run build` in a worktree (the command scripts/runtime-update.mjs uses). */
  build(cwd: string): CmdResult;
  /** The real path of a directory (symlinks resolved); the path itself if it cannot be resolved. */
  realpath(p: string): string;
  log(line: string): void;
}

export interface PostMergeOptions {
  /** Without it nothing is changed except the fetched remote-tracking ref; the plan is printed. */
  apply?: boolean;
  /** No fetch either: the plan is made from the local refs. */
  dryRun?: boolean;
}

const USAGE = "Usage: wolfpack pr post-merge [--dry-run] [--apply]";

/** The arguments of `wolfpack pr post-merge`, from the raw argv: only --dry-run and --apply are accepted. */
export function parsePostMergeArgs(argv: string[]): { apply: boolean; dryRun: boolean } {
  const rest = [...argv];
  for (const word of ["pr", "post-merge"]) {
    const i = rest.indexOf(word);
    if (i >= 0) rest.splice(i, 1);
  }
  const out = { apply: false, dryRun: false };
  for (const a of rest) {
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.dryRun = true;
    else throw new PrRefusal(`unknown argument "${a}". ${USAGE}`);
  }
  if (out.apply && out.dryRun) throw new PrRefusal(`use either --apply or --dry-run, not both. ${USAGE}`);
  return out;
}

interface Worktree {
  path: string;
  branch?: string;
}

const detail = (r: CmdResult) => (r.err.trim() || r.out.trim()).split("\n").slice(0, 4).join(" | ");

export async function prPostMerge(opts: PostMergeOptions, deps: PostMergeDeps): Promise<{ failed: boolean }> {
  const { git, log } = deps;
  const apply = Boolean(opts.apply);
  let failed = false;

  const must = (r: CmdResult, what: string): string => {
    if (r.code !== 0) throw new PrRefusal(`${what} failed: ${detail(r)}`);
    return r.out.trim();
  };
  /** 0 = ancestor, 1 = not; anything else is git failing and stops the run. */
  const isAncestor = (a: string, b: string): boolean => {
    const r = git(["merge-base", "--is-ancestor", a, b]);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new PrRefusal(`git merge-base --is-ancestor ${a} ${b} failed: ${detail(r)}`);
  };

  // Where we are run from: the real path of this worktree and the branch its HEAD is on. Paths are compared by real path.
  const real = (p: string) => deps.realpath(p);
  const current = real(must(git(["rev-parse", "--show-toplevel"]), "git rev-parse --show-toplevel"));
  const headRef = git(["symbolic-ref", "--short", "-q", "HEAD"]);
  const currentBranch = headRef.code === 0 && headRef.out.trim() ? headRef.out.trim() : undefined;
  const currentWolf = currentBranch && /^wolf\/[^/]+$/.test(currentBranch) ? currentBranch : undefined;

  if (opts.dryRun) log("dry run: not fetching; using the local origin/stable (it may be stale)");
  else must(git(["fetch", "origin", "+refs/heads/stable:refs/remotes/origin/stable"]), "git fetch");
  const tip = must(git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/stable^{commit}"]), "reading origin/stable");

  // Worktrees from git itself, never from assumed paths. The first entry is the main checkout.
  const worktrees: Worktree[] = [];
  let cur: Worktree | undefined;
  for (const line of must(git(["worktree", "list", "--porcelain"]), "git worktree list").split("\n")) {
    if (line.startsWith("worktree ")) worktrees.push((cur = { path: line.slice(9) }));
    else if (line.startsWith("branch refs/heads/") && cur) cur.branch = line.slice(18);
  }
  const main = worktrees[0] ? real(worktrees[0].path) : undefined;
  const tips = new Map<string, string>();
  for (const line of must(git(["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads/"]), "git for-each-ref").split("\n")) {
    const [name, sha] = line.split("\t");
    if (name && sha) tips.set(name, sha);
  }

  // Strict on purpose: untracked files count as dirty (a removal must never lose them). Only generated files are ignored.
  const dirty = (path: string) => {
    const r = git(["status", "--porcelain"], path);
    if (r.code !== 0) throw new PrRefusal(`git status in ${path} failed: ${detail(r)}`);
    // Not trimmed: the first status column can be a space, and the path starts at column 3.
    return hasRealChanges(r.out);
  };

  log(`${apply ? "post-merge" : "post-merge plan"}: origin/stable is at ${tip.slice(0, 12)}`);

  // 1. Fast-forward `stable` and the current wolf's branch, nothing else. Skip any that is dirty or has diverged, and say so.
  const moved: string[] = [];
  let stablePath: string | undefined;
  for (const w of worktrees) {
    const b = w.branch;
    if (!b || !(b === "stable" || b.startsWith("wolf/"))) continue;
    if (b !== "stable" && b !== currentWolf) {
      log(`left alone ${b} (${w.path}): it is not the current wolf's branch`);
      continue;
    }
    const head = tips.get(b) ?? "";
    if (dirty(w.path)) {
      log(`skipped ${b} (${w.path}): it has uncommitted changes`);
    } else if (head === tip) {
      log(`${b} is already up to date`);
      if (b === "stable") stablePath = w.path;
    } else if (isAncestor(tip, head)) {
      log(`${b} is ahead of origin/stable; nothing to do`);
      if (b === "stable") stablePath = w.path;
    } else if (!isAncestor(head, tip)) {
      log(`skipped ${b} (${w.path}): it has diverged from origin/stable (cannot fast-forward); run \`wolfpack pr prepare\` to merge stable into it`);
    } else if (!apply) {
      log(`would fast-forward ${b} (${w.path})`);
      moved.push(w.path);
      if (b === "stable") stablePath = w.path;
    } else {
      const r = git(["merge", "--ff-only", "origin/stable"], w.path);
      if (r.code !== 0) log(`skipped ${b} (${w.path}): the fast-forward failed: ${detail(r)}`);
      else {
        log(`fast-forwarded ${b} (${w.path})`);
        moved.push(w.path);
        if (b === "stable") stablePath = w.path;
      }
    }
  }
  if (!currentWolf) {
    log(`the wolf branch was not touched: this worktree is ${currentBranch ? `on ${currentBranch}, not on a wolf/<name> branch` : "not on a wolf/<name> branch (detached HEAD)"}; run this from your wolf/<name> worktree to fast-forward it`);
  }

  // 2. Feature branches that were merged into origin/stable: archive the tip, then remove the clean worktree and delete the branch.
  // "Merged" needs proof, because a branch cut from stable with no commits of its own is also an ancestor of origin/stable.
  const mergeParents = new Set<string>();
  for (const line of must(git(["rev-list", "--merges", "--parents", "refs/remotes/origin/stable"]), "git rev-list --merges").split("\n")) {
    for (const parent of line.trim().split(/\s+/).slice(2)) mergeParents.add(parent); // not the first parent: that is the line it merged into
  }
  const otherTips = new Set<string>([tip]);
  for (const [name, sha] of tips) if (name === "stable" || name.startsWith("wolf/")) otherTips.add(sha);

  /** True when the branch certainly had commits of its own that reached origin/stable. */
  const provenMerged = (b: string, sha: string): boolean => {
    if (otherTips.has(sha)) return false; // it is where stable or a wolf branch is: nothing of its own
    const reflog = git(["reflog", "show", "--format=%H%x09%gs", `refs/heads/${b}`]);
    const entries = reflog.code === 0 ? reflog.out.split("\n").map((x) => x.trim()).filter(Boolean) : [];
    // A reflog that only shows movement (fast-forward, reset, merge) is not enough: the branch needs a commit of its own.
    // "commit", "commit (merge)", "commit (amend)" and "commit (initial)" all start with "commit".
    if (entries.length) return entries.some((e) => (e.split("\t")[1] ?? "").startsWith("commit"));
    return mergeParents.has(sha); // no reflog (fresh clone, expired): a merge commit with the tip as a non-first parent
  };

  for (const [b, sha] of tips) {
    if (!b.startsWith("feat/")) continue;
    if (!isAncestor(sha, tip)) {
      log(`${b}: not in origin/stable yet; left alone`);
      continue;
    }
    if (!provenMerged(b, sha)) {
      log(`${b}: can't prove it was merged; left alone`);
      continue;
    }
    // Keep checks that do not depend on the files in the worktree come first, so nothing is archived for a branch that is kept.
    const w = worktrees.find((x) => x.branch === b);
    const keep = w
      ? b === currentBranch || real(w.path) === current
        ? "it is the current worktree"
        : real(w.path) === main
          ? "it is the main checkout"
          : undefined
      : b === currentBranch
        ? "it is the branch of the current worktree"
        : undefined;
    if (keep) {
      log(`${b}: ${apply ? "kept" : "would keep"}${w ? ` the worktree ${w.path}` : " the branch"}: ${keep}; the branch stays`);
      continue;
    }
    const ref = `refs/archive/${b}`;
    const have = git(["rev-parse", "--verify", "--quiet", ref]);
    const at = have.code === 0 ? have.out.trim() : undefined;
    if (at !== undefined && at !== sha) {
      log(`${b}: ${ref} already points at ${at}, not ${sha}; kept the branch and its worktree`);
      continue;
    }
    if (at === undefined) {
      if (!apply) log(`would archive ${b} at ${ref}`);
      else {
        // The empty old value makes git refuse if the ref appeared in the meantime: an archive is never overwritten.
        const r = git(["update-ref", ref, sha, ""]);
        if (r.code !== 0) {
          log(`${b}: could not archive it at ${ref}: ${detail(r)}; kept the branch and its worktree`);
          continue;
        }
        log(`archived ${b} at ${ref}`);
      }
    }
    if (w) {
      if (dirty(w.path)) {
        log(`${b}: ${apply ? "kept" : "would keep"} the worktree ${w.path}: it has uncommitted changes; the branch stays`);
        continue;
      }
      if (!apply) log(`would remove the worktree ${w.path}`);
      else {
        const r = git(["worktree", "remove", w.path]);
        if (r.code !== 0) {
          log(`${b}: could not remove the worktree ${w.path}: ${detail(r)}; the branch stays`);
          continue;
        }
        log(`removed the worktree ${w.path}`);
      }
    }
    if (!apply) log(`would delete the branch ${b} (git branch -d)`);
    else {
      const r = git(["branch", "-d", b], stablePath);
      if (r.code !== 0) log(`${b}: could not delete ${b}: ${detail(r)}`);
      else log(`deleted the branch ${b} (kept at ${ref})`);
    }
  }

  // 3. Rebuild what moved, with the same command as scripts/runtime-update.mjs.
  if (!moved.length) log("nothing was fast-forwarded: no build");
  else if (!apply) log(`would build (npx turbo run build) in: ${moved.join(", ")}`);
  else {
    for (const path of moved) {
      log(`building ${path}…`);
      const r = deps.build(path);
      if (r.code !== 0) {
        failed = true;
        log(`build failed in ${path}: ${detail(r)}`);
      }
    }
  }

  if (!apply) log("Nothing was changed; run again with --apply to do this.");
  return { failed };
}
