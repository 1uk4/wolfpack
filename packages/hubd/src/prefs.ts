/**
 * Per-person preferences (work-wolfpack-H1OQNIh): small JSON values keyed by (person, key), e.g. the console's graph settings.
 * GET/PUT /v1/prefs/:key. The person is `AuthIdentity.owner` of the bearer token: today every token maps to the single owner
 * identity ("owner"), so all of one hub's paired devices share one value. When the hub grows real per-person tokens, `owner`
 * carries the person and nothing here changes. Nothing the client sends can name the person.
 *
 * Storage: <dataDir>/prefs/<person>/<key>.json, written atomically (writeFileAtomic); async I/O only (no sync disk on request paths).
 * A value is any JSON value, at most MAX_PREF_BYTES serialized.
 */
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@wolfpack/memory";
import { HubError } from "./errors.js";

export const MAX_PREF_BYTES = 32 * 1024;
/** At most this many keys per person: a PUT that would create one more is 400. */
export const MAX_PREF_KEYS = 32;
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const PERSON = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface PrefsStore {
  /** The stored value, or `null` when this person has none for the key. */
  get(person: string, key: string): Promise<unknown>;
  /** Replace the value; 400 `invalid_request` for a bad key or a value over MAX_PREF_BYTES. */
  put(person: string, key: string, value: unknown): Promise<void>;
}

function check(person: string, key: string): void {
  if (!PERSON.test(person)) throw new HubError("invalid_request", "invalid person");
  if (!KEY.test(key) || key.includes("..")) throw new HubError("invalid_request", "invalid pref key");
}

export function createPrefsStore(dataDir: string): PrefsStore {
  const file = (person: string, key: string) => join(dataDir, "prefs", person, `${key}.json`);
  return {
    async get(person, key) {
      check(person, key);
      let raw: string;
      try {
        raw = await readFile(file(person, key), "utf8");
      } catch {
        return null;
      }
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null; // a corrupt file reads as "no value"; the next PUT replaces it
      }
    },
    async put(person, key, value) {
      check(person, key);
      const text = JSON.stringify(value);
      if (text === undefined) throw new HubError("invalid_request", "value must be JSON");
      if (Buffer.byteLength(text) > MAX_PREF_BYTES) throw new HubError("invalid_request", `value too large (max ${MAX_PREF_BYTES} bytes)`);
      const existing = await readdir(join(dataDir, "prefs", person)).catch(() => [] as string[]);
      const mine = `${key}.json`;
      if (!existing.includes(mine) && existing.filter((f) => f.endsWith(".json")).length >= MAX_PREF_KEYS) {
        throw new HubError("invalid_request", `too many pref keys (max ${MAX_PREF_KEYS})`);
      }
      await mkdir(join(dataDir, "prefs", person), { recursive: true });
      await writeFileAtomic(file(person, key), text);
    },
  };
}
