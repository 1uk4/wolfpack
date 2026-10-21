/**
 * Planner timer (opt-in via wolf.yaml `planner.enabled`) — checks den/planner/state.json every minute and sends
 * Telegram pings when block transitions are due.
 *
 * Sends messages to the wolf's own Telegram chat via the bot API,
 * which triggers a normal conversation turn where the wolf follows
 * the day-planner skill.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TelegramSharedState } from "../extension-api.js";

interface PlannerState {
  todayTaskId?: string;
  todayCardMessageId?: number;
  blocks?: Array<{
    time: string;
    slug: string;
    pinged: boolean;
  }>;
  nudgeSent?: boolean;
  lastResponse?: string;
  lastPingTime?: string;
  activeMinutes?: number;
  idleMinutes?: number;
}

export function startPlannerTimer(
  wolfDen: string,
  telegram: TelegramSharedState | undefined,
  timeZone?: string,
): () => void {
  const statePath = join(wolfDen, "planner", "state.json");

  function readState(): PlannerState {
    try {
      return JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      return {};
    }
  }

  function writeState(state: PlannerState): void {
    const dir = dirname(statePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  function currentTime(): string {
    return new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone,
    });
  }

  const interval = setInterval(async () => {
    try {
      if (!telegram?.botApi) return;

      const state = readState();
      if (!state.blocks || state.blocks.length === 0) return;

      const now = currentTime();
      const chatId = telegram.botApi.getChatId();
      if (!chatId) return;

      for (const block of state.blocks) {
        if (block.pinged) continue;
        if (now >= block.time) {
          block.pinged = true;
          state.lastPingTime = now;
          state.nudgeSent = false;
          writeState(state);

          await telegram.botApi.sendMessage(
            chatId,
            `[planner] Block transition: ${block.time} · ${block.slug}`,
          );
          break;
        }
      }

      // Nudge check: if last ping was 15+ min ago and no response
      if (state.lastPingTime && !state.nudgeSent && state.lastResponse) {
        const lastPing = new Date(state.lastPingTime).getTime();
        const lastResp = new Date(state.lastResponse).getTime();
        const elapsed = Date.now() - Math.max(lastPing, lastResp);
        if (elapsed > 15 * 60 * 1000) {
          state.nudgeSent = true;
          writeState(state);
          await telegram.botApi.sendMessage(chatId, "[planner] Still on task?");
        }
      }
    } catch {
      // Timer should never crash the harness
    }
  }, 60_000);

  return () => clearInterval(interval);
}
