import type { CommandContext, Context } from "grammy";
import { run } from "../exec.ts";
import { findWolf, loadWolves } from "../inventory.ts";

const DEFAULT_LINES = 30;
const MAX_LINES = 200;
const TELEGRAM_MSG_LIMIT = 3800;

export async function logsCommand(
  ctx: CommandContext<Context>,
  inventoryPath: string,
): Promise<void> {
  const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    await ctx.reply("Usage: /logs <wolf> [lines]");
    return;
  }

  const name = args[0]!;
  const rawN = args[1] ? parseInt(args[1], 10) : DEFAULT_LINES;
  const n = Number.isFinite(rawN) && rawN > 0 ? Math.min(rawN, MAX_LINES) : DEFAULT_LINES;

  const wolves = loadWolves(inventoryPath);
  const wolf = findWolf(wolves, name);
  if (!wolf) {
    await ctx.reply(`Unknown wolf: ${name}. Known: ${wolves.map((w) => w.name).join(", ")}`);
    return;
  }

  const result = await run(
    "sudo",
    ["-n", "journalctl", "-u", wolf.service, "-n", String(n), "--no-pager"],
    30_000,
  );

  if (result.code !== 0) {
    await ctx.reply(`journalctl failed (exit ${result.code}):\n${result.stderr.slice(0, 1000)}`);
    return;
  }

  let body = result.stdout.trim() || "(no output)";
  if (body.length > TELEGRAM_MSG_LIMIT) {
    body = body.slice(-TELEGRAM_MSG_LIMIT);
    body = `…(truncated, showing last ${TELEGRAM_MSG_LIMIT} chars)\n` + body;
  }

  await ctx.reply("```\n" + body + "\n```", { parse_mode: "MarkdownV2" }).catch(async () => {
    await ctx.reply(body);
  });
}
