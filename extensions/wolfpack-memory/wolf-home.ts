import { dirname } from "node:path";

/**
 * The wolf's home, for per-wolf prompt overrides (`<wolf-home>/agent/prompts`). `WOLF_HOME` when set; else the parent of
 * `WOLF_DEN`, since a den is always `<wolf-home>/den` (packages/agent/src/wolf-manager.ts:97 and :201); else unknown.
 */
export function resolveWolfHome(env: Record<string, string | undefined> = process.env): string | undefined {
  return env.WOLF_HOME ?? (env.WOLF_DEN ? dirname(env.WOLF_DEN) : undefined);
}
