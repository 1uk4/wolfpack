/**
 * Active hours: the clock the promote pass ages topics by. An hour counts when the owner sent at least one message in
 * any channel (console, phone, Telegram) during it. Being away does not count, so a topic does not "go quiet" over a night.
 *
 * `<den>/memory/active-hours.json` = `{version: 1, hours: ["2026-11-13T09", …]}`: UTC hour keys, sorted, pruned to 60 days,
 * written atomically (tmp file + rename).
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const ACTIVE_HOURS_RETENTION_DAYS = 60;

export const activeHoursFile = (den: string): string => join(den, "memory", "active-hours.json");

/** The UTC hour key of a moment: `2026-11-13T09`. */
export const hourKey = (at: Date): string => at.toISOString().slice(0, 13);

/** The recorded hour keys, sorted; [] when the file is absent or unreadable. */
export function readActiveHours(den: string): string[] {
  try {
    if (!existsSync(activeHoursFile(den))) return [];
    const parsed = JSON.parse(readFileSync(activeHoursFile(den), "utf8")) as { hours?: unknown };
    return Array.isArray(parsed.hours) ? parsed.hours.filter((h): h is string => typeof h === "string").sort() : [];
  } catch {
    return [];
  }
}

function writeHours(den: string, hours: string[]): void {
  const file = activeHoursFile(den);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, hours }));
  renameSync(tmp, file);
}

/** Record that the owner sent a message at `at`. Writes only when the hour is new or old hours need pruning. */
export function recordOwnerMessage(den: string, at: Date = new Date()): void {
  const hours = readActiveHours(den);
  const key = hourKey(at);
  const oldest = hourKey(new Date(at.getTime() - ACTIVE_HOURS_RETENTION_DAYS * 86_400_000));
  const kept = hours.filter((h) => h >= oldest);
  if (kept.length === hours.length && hours.includes(key)) return;
  if (!kept.includes(key)) kept.push(key);
  writeHours(den, kept.sort());
}

/** Active hours strictly after the hour containing `since` (the hour `since` falls in is not counted). */
export function activeHoursSince(den: string, since: Date): number {
  const from = hourKey(since);
  return readActiveHours(den).filter((h) => h > from).length;
}

/** Seed the clock from past timestamps (the migration): adds their hours without pruning future-proof keys. */
export function seedActiveHours(den: string, stamps: Date[]): void {
  const hours = new Set(readActiveHours(den));
  for (const s of stamps) if (!Number.isNaN(s.getTime())) hours.add(hourKey(s));
  writeHours(den, [...hours].sort());
}
