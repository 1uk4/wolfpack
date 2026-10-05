import { run, type ExecResult } from "./exec.ts";
import type { Wolf } from "./inventory.ts";

/**
 * Run a command on a wolf's droplet over SSH, connecting as the wolf's own
 * unix user (the Mac's wolfpack key is authorized for it). Non-interactive:
 * fails fast instead of prompting.
 */
export function sshRun(wolf: Wolf, remoteCommand: string, timeoutMs = 12_000): Promise<ExecResult> {
  if (!wolf.host) {
    return Promise.resolve({ code: -1, stdout: "", stderr: "no ansible_host in inventory", timedOut: false });
  }

  const args: string[] = [];
  if (wolf.keyFile) args.push("-i", wolf.keyFile);
  // Honor inventory extras (e.g. -o IdentityAgent=none).
  if (wolf.sshExtraArgs) args.push(...wolf.sshExtraArgs.split(/\s+/).filter(Boolean));
  args.push(
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "StrictHostKeyChecking=accept-new",
    `${wolf.user}@${wolf.host}`,
    remoteCommand,
  );

  return run("ssh", args, timeoutMs);
}
