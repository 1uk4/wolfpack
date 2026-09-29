import { spawn } from "node:child_process";

export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

/**
 * Spawn a process and collect its output. Never rejects — inspect `code`.
 * Shared by the CLI (local + ssh) and the cc-bot (local sudo).
 */
export function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: "", stderr: "spawn error", timedOut });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
      });
    });
  });
}
