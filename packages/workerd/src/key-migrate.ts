/**
 * One-time key migration (work-wolfpack-6EmU8pu): copy keys from a wolf's .env, the service env and the console's auth.json into the
 * Pack key file, only for slots the file lacks. The sources are only read, never changed. A marker file records the run, so it happens once.
 * Off unless `enabled`; every path is an explicit input. The Mac app's credentials.json is out of scope (work-wolfpack-RUyVK7j).
 * Never logs or returns a key: the result names slots only.
 */
import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { checkKeyShape, normalizeKey } from "@wolfpack/protocol";
import { SLOT_ENV } from "./key-store.js";

export interface MigrateOptions {
  enabled: boolean;
  keyFile: string;
  /** Records that the migration ran. */
  marker: string;
  /** Wolf `.env` files, read first. */
  wolfEnvFiles?: string[];
  /** Service env files (e.g. the unit's EnvironmentFile). */
  serviceEnvFiles?: string[];
  /** The console's auth.json: `{ "<slot>": "<key>" }`, read last. */
  authJson?: string;
  mode?: number;
}

const read = (p: string): string => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

function envValues(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split("\n")) {
    const mm = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (mm) m.set(mm[1]!, mm[2]!.trim().replace(/^(["'])(.*)\1$/, "$2"));
  }
  return m;
}

export function migrateKeys(o: MigrateOptions): { ran: boolean; copied: string[] } {
  if (!o.enabled || existsSync(o.marker)) return { ran: false, copied: [] };
  const have = envValues(read(o.keyFile));
  const found = new Map<string, string>(); // env name -> first valid value, by source order
  const offer = (name: string, v: unknown, slot: string) => {
    if (typeof v !== "string" || found.has(name) || have.has(name)) return;
    const key = normalizeKey(v);
    if (checkKeyShape(slot, key).ok) found.set(name, key);
  };
  for (const p of [...(o.wolfEnvFiles ?? []), ...(o.serviceEnvFiles ?? [])]) {
    const e = envValues(read(p));
    for (const [slot, name] of Object.entries(SLOT_ENV)) offer(name, e.get(name), slot);
  }
  if (o.authJson) {
    try {
      const j = JSON.parse(read(o.authJson)) as Record<string, unknown>;
      for (const [slot, name] of Object.entries(SLOT_ENV)) offer(name, j[slot], slot);
    } catch {
      /* unreadable auth.json: skip */
    }
  }
  const copied = Object.entries(SLOT_ENV).filter(([, name]) => found.has(name)).map(([slot]) => slot);
  if (copied.length) {
    const prior = read(o.keyFile);
    const add = Object.values(SLOT_ENV).filter((n) => found.has(n)).map((n) => `${n}=${found.get(n)}\n`).join("");
    mkdirSync(dirname(o.keyFile), { recursive: true });
    const tmp = `${o.keyFile}.${process.pid}.tmp`;
    rmSync(tmp, { force: true }); // a stale temp from a crashed run
    const fd = openSync(tmp, "wx", o.mode ?? 0o600); // created with the final mode
    try {
      writeSync(fd, (prior && !prior.endsWith("\n") ? prior + "\n" : prior) + add);
      chmodSync(tmp, o.mode ?? 0o600);
      // Keep the old file's group (sfo-01 shares it with the readers); EPERM when we are not in it is fine.
      if (existsSync(o.keyFile)) {
        try {
          chownSync(tmp, -1, statSync(o.keyFile).gid);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
        }
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, o.keyFile);
  }
  mkdirSync(dirname(o.marker), { recursive: true });
  writeFileSync(o.marker, JSON.stringify({ at: new Date().toISOString(), copied }), { mode: 0o600 });
  return { ran: true, copied };
}
