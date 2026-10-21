/**
 * Planner — a den extension that pings the owner on Telegram when a planned
 * block of the day starts, and nudges once if there's been no reply.
 *
 * Reads <den>/planner/state.json every minute. The ping arrives as a normal
 * message, so the wolf takes a conversation turn on it.
 *
 * wolf.yaml:
 *   extensions: [planner]
 *   planner:
 *     timezone: Europe/Berlin   # IANA zone for block times (default: system)
 *     nudgeAfterMinutes: 15     # default 15
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Extension, LifecycleContext } from "@wolfpack/harness/extension";

interface PlannerState {
  blocks?: Array<{ time: string; slug: string; pinged: boolean }>;
  nudgeSent?: boolean;
  lastResponse?: string;
  lastPingTime?: string;
}

interface PlannerConfig {
  timezone?: string;
  nudgeAfterMinutes?: number;
}

const TICK_MS = 60_000;

export default function planner(config: PlannerConfig = {}): Extension {
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    name: "planner",
    lifecycle: {
      start(ctx: LifecycleContext) {
        const statePath = join(ctx.wolfDen, "planner", "state.json");
        const timeZone = config.timezone;
        const nudgeMs = (config.nudgeAfterMinutes ?? 15) * 60_000;

        const readState = (): PlannerState => {
          if (!existsSync(statePath)) return {};
          try {
            return JSON.parse(readFileSync(statePath, "utf-8"));
          } catch {
            return {};
          }
        };
        const writeState = (state: PlannerState): void => {
          mkdirSync(dirname(statePath), { recursive: true });
          writeFileSync(statePath, JSON.stringify(state, null, 2));
        };
        const now = (): string =>
          new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone });

        timer = setInterval(async () => {
          try {
            const state = readState();
            if (!state.blocks?.length) return;

            const time = now();
            const due = state.blocks.find((b) => !b.pinged && time >= b.time);
            if (due) {
              // Send first: a failed send is retried next tick instead of lost
              if (!(await ctx.send(`[planner] Block transition: ${due.time} · ${due.slug}`))) return;
              due.pinged = true;
              state.lastPingTime = new Date().toISOString();
              state.nudgeSent = false;
              writeState(state);
              return;
            }

            if (state.lastPingTime && state.lastResponse && !state.nudgeSent) {
              const last = Math.max(Date.parse(state.lastPingTime), Date.parse(state.lastResponse));
              if (Date.now() - last > nudgeMs && (await ctx.send("[planner] Still on task?"))) {
                state.nudgeSent = true;
                writeState(state);
              }
            }
          } catch {
            // A timer must never take the harness down
          }
        }, TICK_MS);
      },

      stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
      },
    },
  };
}
