import { Bot } from "grammy";
import { ownerOnly } from "./auth.ts";
import { logsCommand } from "./commands/logs.ts";
import { restartCommand } from "./commands/restart.ts";
import { statusCommand } from "./commands/status.ts";

const token = process.env.TELEGRAM_BOT_TOKEN_WOLFPACK_CC;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN_WOLFPACK_CC is not set");
  process.exit(1);
}

const ownerIdRaw = process.env.OWNER_TELEGRAM_ID;
const ownerId = ownerIdRaw ? parseInt(ownerIdRaw, 10) : NaN;
if (!Number.isFinite(ownerId)) {
  console.error("OWNER_TELEGRAM_ID is not set or not a number");
  process.exit(1);
}

const inventoryPath =
  process.env.WOLFPACK_INVENTORY ?? "/home/wolfpack/wolfpack/inventory/hosts.yml";

const bot = new Bot(token);

bot.use(ownerOnly(ownerId));

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Wolfpack Command Center",
      "",
      "/status — list wolves and their service state",
      "/logs <wolf> [lines] — tail a wolf's journald logs (default 30, max 200)",
      "/restart <wolf> — 2-step restart; ask the wolf to checkpoint first, then /restart <wolf> confirm",
    ].join("\n"),
  );
});

bot.command("status", async (ctx) => {
  await statusCommand(ctx, inventoryPath);
});

bot.command("logs", async (ctx) => {
  await logsCommand(ctx, inventoryPath);
});

bot.command("restart", async (ctx) => {
  await restartCommand(ctx, inventoryPath);
});

bot.catch((err) => {
  console.error("bot error:", err);
});

console.log(`wolfpack-cc starting (owner=${ownerId}, inventory=${inventoryPath})`);
await bot.start({
  onStart: (me) => console.log(`listening as @${me.username} id=${me.id}`),
});
