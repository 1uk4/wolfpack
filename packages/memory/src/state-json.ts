/** Small JSON state files under `<den>/memory/`: read tolerantly, write atomically (tmp file + rename). */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const memoryStateFile = (den: string, name: string): string => join(den, "memory", name);

export function readJsonState<T>(den: string, name: string, fallback: T): T {
  try {
    const file = memoryStateFile(den, name);
    if (!existsSync(file)) return fallback;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as T;
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function writeJsonState(den: string, name: string, value: unknown): void {
  const file = memoryStateFile(den, name);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}
