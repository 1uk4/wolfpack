import type { CommandContext, Context } from "grammy";
import { run } from "../exec.ts";
import { findWolf, loadWolves } from "../inventory.ts";

const CONFIRM_WINDOW_MS = 5 * 60_000;

type PendingConfirm = {
  wolf: string;
  issuedAt: number;
};

const pending = new Map<number, PendingConfirm>();

export async function restartCommand(
  ctx: CommandContext<Context>,
  inventoryPath: string,
): Promise<void> {
  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    await ctx.reply("Usage: /restart <wolf> [confirm]");
    return;
  }

  const name = args[0]!;
  const confirm = args[1]?.toLowerCase() === "confirm";

  const wolves = loadWolves(inventoryPath);
  const wolf = findWolf(wolves, name);
  if (!wolf) {
    await ctx.reply(`Unknown wolf: ${name}. Known: ${wolves.map((w) => w.name).join(", ")}`);
    return;
  }

  const chatId = ctx.chat.id;

  if (!confirm) {
    pending.set(chatId, { wolf: wolf.name, issuedAt: Date.now() });
    await ctx.reply(
      [
        `About to restart *${wolf.name}* (${wolf.service}).`,
        "",
        `Before you confirm: DM ${wolf.name} and ask it to write a checkpoint to \`memory/checkpoints/\` so the fresh session has state to resume from.`,
        "",
        `When ready, send: \`/restart ${wolf.name} confirm\``,
        `Confirmation window: 5 minutes.`,
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
    return;
  }

  const pend = pending.get(chatId);
  if (!pend || pend.wolf !== wolf.name || Date.now() - pend.issuedAt > CONFIRM_WINDOW_MS) {
    await ctx.reply(
      `No recent /restart request for ${wolf.name} in this chat. Run /restart ${wolf.name} first (confirmations expire after 5 min).`,
    );
    return;
  }
  pending.delete(chatId);

  await ctx.reply(`Restarting ${wolf.name}…`);
  const result = await run(
    "sudo",
    ["-n", "systemctl", "restart", wolf.service],
    60_000,
  );

  if (result.code !== 0) {
    await ctx.reply(
      `Restart failed (exit ${result.code}):\n${result.stderr.slice(0, 1000) || result.stdout.slice(0, 1000)}`,
    );
    return;
  }

  await ctx.reply(`${wolf.name} restarted. Give it ~15s to come back up.`);
}
