/**
 * Header git tree: read-only git facts about a thread's workspace (summary `workspace`, and the status route behind the
 * header popover). Every call is an `execFile git` with a timeout, and answers are cached for a few seconds so a busy
 * header (a refresh per thread-updated / turn end / focus) does not fork git each time.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { ThreadWorkspace, WorkspaceStatus } from "@wolfpack/protocol";

const GIT_TIMEOUT_MS = 5000;
const MAX_DIRTY = 200;
const COMMITS = 5;

function run(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((done) => {
    execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } }, (err, stdout) => {
      done({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stdout: stdout ?? "" });
    });
  });
}

const real = (p: string): string => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

export class GitInfo {
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly ttlMs = 5000) {}

  private cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value as Promise<T>;
    const value = fn();
    this.cache.set(key, { at: Date.now(), value });
    if (this.cache.size > 200) for (const [k, v] of this.cache) if (Date.now() - v.at >= this.ttlMs) this.cache.delete(k);
    return value;
  }

  /** The checked-out branch of `dir` ("HEAD" when detached), or undefined when `dir` is not in a git checkout. */
  branchOf(dir: string): Promise<string | undefined> {
    return this.cached(`branch\0${dir}`, async () => {
      const r = await run(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (r.code === 0) return r.stdout.trim() || undefined;
      // An unborn branch has no HEAD yet: ask for the symbolic name.
      const u = await run(dir, ["symbolic-ref", "--short", "HEAD"]);
      return u.code === 0 ? u.stdout.trim() || undefined : undefined;
    });
  }

  /** The thread's workspace at `dir`, or undefined when it is not in a git checkout. `base` is passed through. */
  workspaceOf(dir: string, base?: string): Promise<ThreadWorkspace | undefined> {
    return this.cached(`ws\0${dir}\0${base ?? ""}`, async () => {
      const top = await run(dir, ["rev-parse", "--show-toplevel", "--git-common-dir"]);
      if (top.code !== 0) return undefined;
      const [t, common] = top.stdout.split("\n").map((s) => s.trim());
      if (!t || !common) return undefined;
      const toplevel = real(t);
      const commonDir = real(resolve(dir, common));
      const mainDir = basename(commonDir) === ".git" ? dirname(commonDir) : toplevel;
      const branch = await this.branchOf(dir);
      if (!branch) return undefined;
      return { repo: basename(mainDir), toplevel, ...(base ? { base } : {}), branch, path: real(dir), isWorktree: toplevel !== real(mainDir) };
    });
  }

  /** Branch of the repo's main checkout (what a feature branch was cut from when nothing was recorded). */
  async mainBranch(dir: string): Promise<string | undefined> {
    const top = await run(dir, ["rev-parse", "--git-common-dir"]);
    if (top.code !== 0) return undefined;
    const commonDir = real(resolve(dir, top.stdout.trim()));
    return this.branchOf(basename(commonDir) === ".git" ? dirname(commonDir) : dir);
  }

  /** Live state of the checkout at `ws.path`: ahead/behind `ws.base`, dirty files, last commits. */
  status(ws: ThreadWorkspace, children: WorkspaceStatus["children"]): Promise<WorkspaceStatus> {
    return this.cached(`status\0${ws.path}\0${ws.base ?? ""}`, async () => {
      const [counts, dirty, log] = await Promise.all([
        ws.base ? run(ws.path, ["rev-list", "--left-right", "--count", `${ws.base}...HEAD`]) : Promise.resolve({ code: 1, stdout: "" }),
        run(ws.path, ["status", "--porcelain=v1", "--untracked-files=normal"]),
        run(ws.path, ["log", `-${COMMITS}`, "--format=%H%x1f%s%x1f%cI"]),
      ]);
      const [behind, ahead] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map((n) => Number(n) || 0) : [0, 0];
      return {
        branch: ws.branch,
        ahead: ahead ?? 0,
        behind: behind ?? 0,
        dirty: dirty.stdout.split("\n").filter((l) => l.length > 3).slice(0, MAX_DIRTY).map((l) => ({ status: l.slice(0, 2), path: l.slice(3) })),
        commits: log.stdout.split("\n").filter(Boolean).map((l) => {
          const [sha = "", subject = "", at = ""] = l.split("\x1f");
          return { sha, subject, at };
        }),
        children,
      };
    });
  }
}
