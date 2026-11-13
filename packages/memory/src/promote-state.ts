/**
 * Promote state, `<den>/memory/promote-state.json`: what the promote pass knows about each session topic, and the day
 * the daily pass last ran. A topic is retired only when it is promoted, a create/merge receipt confirmed it, and it has
 * been inactive 8 active hours; these facts are what that check reads.
 */
import { readActiveHours } from "./active-hours.js";
import { readJsonState, writeJsonState } from "./state-json.js";

const FILE = "promote-state.json";

export interface TopicPromoteState {
  promotedAt?: string;
  /** The create/merge receipt that confirmed the topic (entryIds primary first). */
  receipt?: { outcome: "create" | "merge" | "reject"; entryIds: string[] };
  retiredAt?: string;
  /** Why the topic stays: parked (unclassified/parked receipt) is shown in the panel. */
  state?: "parked";
}
export interface PromoteState {
  version: 1;
  /** UTC day (`2026-11-13`) the daily pass last ran. */
  lastActiveDayPassed?: string;
  topics: Record<string, TopicPromoteState>;
}

export function readPromoteState(den: string): PromoteState {
  const raw = readJsonState<Partial<PromoteState>>(den, FILE, {});
  return {
    version: 1,
    ...(typeof raw.lastActiveDayPassed === "string" ? { lastActiveDayPassed: raw.lastActiveDayPassed } : {}),
    topics: raw.topics && typeof raw.topics === "object" ? raw.topics : {},
  };
}

export function updateTopicState(den: string, topicId: string, patch: TopicPromoteState): void {
  const state = readPromoteState(den);
  state.topics[topicId] = { ...state.topics[topicId], ...patch };
  writeJsonState(den, FILE, state);
}

const dayOf = (at: Date): string => at.toISOString().slice(0, 10);

/** True when the owner was active today (UTC) and the daily pass has not run yet today. */
export function dailyPassDue(den: string, now: Date = new Date()): boolean {
  const day = dayOf(now);
  if (readPromoteState(den).lastActiveDayPassed === day) return false;
  return readActiveHours(den).some((h) => h.startsWith(day));
}

export function markDailyPass(den: string, now: Date = new Date()): void {
  const state = readPromoteState(den);
  state.lastActiveDayPassed = dayOf(now);
  writeJsonState(den, FILE, state);
}
