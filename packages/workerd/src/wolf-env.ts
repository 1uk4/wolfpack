import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ON = /^(1|true|yes|on)$/i;

/** Value of `key` in a dotenv-style text (KEY=VALUE, `#` comments, optional quotes, optional `export `). Never logs. */
export function dotenvValue(text: string, key: string): string | undefined {
  let found: string | undefined;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0 || line.slice(0, eq).trim() !== key) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    found = v; // last one wins, like systemd's EnvironmentFile
  }
  return found;
}

/**
 * Does the wolf's OWN `.env` (the file its unit loads via EnvironmentFile=, which workerd's process does not inherit) set WOLFPACK_HUB_KB on?
 * The wolf home is where wolfd looks (`hub-kb.ts`: WOLF_HOME, else the wolf.yaml dir); workerd cannot know WOLF_HOME before reading the file, so it tries
 * the wolf.yaml directory and up to three ancestors, nearest first. An unreadable file (the workerd user may not own it) counts as off. Reads only; values are never returned or logged.
 */
export function wolfEnvHubKb(configFile: string): boolean {
  let dir = dirname(configFile);
  for (let i = 0; i < 4; i++) {
    try {
      return ON.test((dotenvValue(readFileSync(join(dir, ".env"), "utf8"), "WOLFPACK_HUB_KB") ?? "").trim());
    } catch {
      /* no readable .env here: try the parent */
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}
