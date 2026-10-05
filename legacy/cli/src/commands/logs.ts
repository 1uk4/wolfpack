import { findWolf, loadWolves, sshRun } from "@wolfpack/core";
import { c } from "../render.ts";

const DEFAULT_LINES = 50;
const MAX_LINES = 1000;

export async function logsCommand(
  name: string | undefined,
  linesArg: string | undefined,
): Promise<void> {
  const wolves = loadWolves();
  if (!name) {
    console.error(`Usage: wolfpack logs <wolf> [lines]  (max ${MAX_LINES})`);
    console.error(`Known: ${wolves.map((w) => w.name).join(", ")}`);
    process.exit(1);
  }
  const wolf = findWolf(wolves, name);
  if (!wolf) {
    console.error(`Unknown wolf: ${name}. Known: ${wolves.map((w) => w.name).join(", ")}`);
    process.exit(1);
  }

  const parsed = linesArg ? parseInt(linesArg, 10) : DEFAULT_LINES;
  const n = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LINES) : DEFAULT_LINES;

  // journalctl needs root; the wolf user has NOPASSWD via cc-bot's sudoers
  // pattern, but the CLI keys into the wolf user directly, which has full sudo.
  const res = await sshRun(
    wolf,
    `sudo -n journalctl -u ${wolf.service} -n ${n} --no-pager`,
    30_000,
  );

  if (res.code !== 0) {
    console.error(c.red(`journalctl failed (exit ${res.code}):`));
    console.error(res.stderr.trim() || "(no stderr)");
    process.exit(res.code);
  }
  process.stdout.write(res.stdout);
}
