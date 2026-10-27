import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempRepo {
  /** Sandbox dir that holds the repo and anything else (e.g. a workspaces root). */
  base: string;
  /** Repo working dir (<base>/<name>). */
  dir: string;
  /** Suggested workspaces root (<base>/workspaces). */
  root: string;
  git(args: string[], cwd?: string): string;
  /** Write a file (relative to cwd, default repo dir), `git add` and commit it. Returns the sha. */
  commitFile(rel: string, content: string, message?: string, cwd?: string): string;
  cleanup(): void;
}

/** A throwaway git repo (branch main, one initial commit) in a fresh temp dir. Never touches real repos. */
export function makeTempRepo(name = "demo"): TempRepo {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "wolf-ws-")));
  const dir = join(base, name);
  mkdirSync(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (args: string[], cwd = dir) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "commit.gpgsign", "false"]);
  const commitFile = (rel: string, content: string, message = `update ${rel}`, cwd = dir) => {
    const p = join(cwd, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    run(["add", "--", rel], cwd);
    run(["commit", "-q", "-m", message], cwd);
    return run(["rev-parse", "HEAD"], cwd);
  };
  commitFile("README.md", "# demo\n", "initial");
  return { base, dir, root: join(base, "workspaces"), git: run, commitFile, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}
