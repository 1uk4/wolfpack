import type { CommandContext, Context } from "grammy";
import { run } from "../exec.ts";
import { loadWolves } from "../inventory.ts";

export async function statusCommand(
  ctx: CommandContext<Context>,
  inventoryPath: string,
): Promise<void> {
  const wolves = loadWolves(inventoryPath);
  if (wolves.length === 0) {
    await ctx.reply("No wolves in inventory.");
    return;
  }

  const lines: string[] = [];
  for (const wolf of wolves) {
    const active = await run("sudo", ["-n", "systemctl", "is-active", wolf.service]);
    const uptime = await run("sudo", [
      "-n",
      "systemctl",
      "show",
      wolf.service,
      "--property=ActiveEnterTimestamp",
      "--value",
    ]);
    const state = active.stdout.trim() || "unknown";
    const ts = uptime.stdout.trim();
    const marker = state === "active" ? "🟢" : "🔴";
    const tsLabel = ts && ts !== "n/a" ? ` since ${ts}` : "";
    lines.push(`${marker} ${wolf.name} — ${state}${tsLabel}`);
  }

  await ctx.reply(lines.join("\n"));
}
