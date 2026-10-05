/**
 * SSH utilities for bootstrapping hosts.
 *
 * Used by `wolfpack host add` to set up a new VPS before
 * the agent is running.
 */

import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a command via SSH on a remote host */
export function sshExec(
  host: string,
  command: string,
  user = "root",
  timeoutMs = 30_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const args = [
      "-o", "BatchMode=yes",
      "-o", "ConnectTimeout=10",
      "-o", "StrictHostKeyChecking=accept-new",
      `${user}@${host}`,
      command,
    ];

    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
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

/** Copy a file to a remote host via scp */
export function scp(
  localPath: string,
  remotePath: string,
  host: string,
  user = "root",
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const dest = `${user}@${host}:${remotePath}`;
    const child = spawn("scp", [
      "-o", "BatchMode=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      localPath,
      dest,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const out: Buffer[] = [];
    const err: Buffer[] = [];

    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));

    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut: false,
      });
    });
  });
}
