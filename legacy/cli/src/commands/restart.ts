import { findWolf, loadWolves, sshRun } from "@wolfpack/core";
import { c } from "../render.ts";

export async function restartCommand(
  name: string | undefined,
  subcommand: string | undefined,
): Promise<void> {
  const wolves = loadWolves();
  if (!name) {
    console.error("Usage: wolfpack restart <wolf> [confirm]");
    console.error(`Known: ${wolves.map((w) => w.name).join(", ")}`);
    process.exit(1);
  }
  const wolf = findWolf(wolves, name);
  if (!wolf) {
    console.error(`Unknown wolf: ${name}. Known: ${wolves.map((w) => w.name).join(", ")}`);
    process.exit(1);
  }

  // First call: warn and ask for a second call with 'confirm'. Restarts kill
  // the tmux session and the wolf loses any in-flight in-memory work — the
  // wolf should checkpoint before the restart lands.
  if (subcommand !== "confirm") {
    console.log(c.yellow(`⚠️  Restarting ${wolf.name} ends its tmux session.`));
    console.log("");
    console.log("Recommended sequence:");
    console.log(`  1. DM ${wolf.name} on Telegram: 'checkpoint and prepare to restart'`);
    console.log(`  2. Wait for the checkpoint confirmation`);
    console.log(`  3. Re-run: ${c.bold(`wolfpack restart ${wolf.name} confirm`)}`);
    return;
  }

  console.log(`Restarting ${wolf.name}…`);
  const res = await sshRun(
    wolf,
    `sudo -n systemctl restart ${wolf.service} && sleep 2 && systemctl is-active ${wolf.service}`,
    30_000,
  );

  if (res.code !== 0) {
    console.error(c.red(`Restart failed (exit ${res.code}):`));
    console.error(res.stderr.trim() || res.stdout.trim() || "(no output)");
    process.exit(res.code);
  }

  const state = res.stdout.trim().split("\n").pop() ?? "unknown";
  const ok = state === "active";
  console.log(
    ok
      ? c.green(`✓ ${wolf.name} restarted (${state})`)
      : c.red(`✗ ${wolf.name} state after restart: ${state}`),
  );
  console.log(c.dim(`  verify: ./wolfpack status ${wolf.name}`));
  if (!ok) process.exit(1);
}
