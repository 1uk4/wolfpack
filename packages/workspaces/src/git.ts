import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

let gitCommand = "git";
/** Test seam: the git executable every call here runs. Returns the previous one. */
export function setGitCommand(cmd: string): string {
  const prev = gitCommand;
  gitCommand = cmd;
  return prev;
}

/** Run git with an argv array (never a shell string). Resolves with the exit code instead of throwing. */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(gitCommand, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" }, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const code = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1;
      resolve({ code, stdout: stdout ?? "", stderr: stderr || String(err.message) });
    });
  });
}

/** Run git and return trimmed stdout; throws with git's stderr on failure. */
export async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
