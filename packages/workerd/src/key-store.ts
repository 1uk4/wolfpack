/**
 * The machine's key file and the KeyHandler that writes it (work-wolfpack-6EmU8pu).
 * One env-style file per machine (`KEY=value` lines, written atomically, mode 0600 by default; 0640 on sfo-01 with a shared group).
 * The location is always an explicit input. The Pack's file wins over the machine's own environment: whatever reads keys loads this
 * file after the environment, so the Pack's value overrides.
 *
 * key.set: unseal -> freshness (5 min) -> replay (seen cmdIds: 1000 in memory, newest 100 persisted) -> provider check -> atomic write
 * -> restart the wolves that use the slot. A rejected check keeps the old key. Never log or return a key.
 */
import { chmodSync, chownSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { PROVIDERS, maskKey, normalizeKey, providerForSlot, unseal, type CheckResult, type RestartedWolf } from "@wolfpack/protocol";
import type { KeyHandler, KeyResult } from "./commands.js";

/** Environment variable each key slot is stored under. */
export const SLOT_ENV: Readonly<Record<string, string>> = { anthropic: "ANTHROPIC_API_KEY", deepgram: "DEEPGRAM_API_KEY" };

export const SEAL_MAX_AGE_MS = 5 * 60_000;
const SEEN_MEMORY = 1000;
const SEEN_PERSIST = 100;

export interface KeyStoreOptions {
  /** The key file. Explicit: never inferred from a home directory. */
  file: string;
  /** Where the newest seen cmdIds are persisted. */
  seenFile: string;
  privateKeyPkcs8: Uint8Array;
  checker: { check(slot: string, value: string): Promise<CheckResult> };
  /** Restart the wolves that use `slot`'s key; returns the ones restarted (named in the result). */
  restartWolvesUsing(slot: string): Promise<RestartedWolf[]>;
  now?: () => number;
  /** File mode, default 0600. */
  mode?: number;
  /** Create the file's directory when missing (default true). */
  createDirs?: boolean;
}

function parseEnv(text: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const mm = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (mm) m.set(mm[1]!, mm[2]!);
  }
  return m;
}

function readFileEnv(file: string): Map<string, string> {
  try {
    return parseEnv(readFileSync(file, "utf8"));
  } catch {
    return new Map();
  }
}

/** The key slots stored in `file`, as env variables (name -> value). Missing or unreadable file = empty. For spawning processes: never log it. */
export function readKeyFileEnv(file: string): Record<string, string> {
  const all = readFileEnv(file);
  const out: Record<string, string> = {};
  for (const name of Object.values(SLOT_ENV)) {
    const v = all.get(name);
    if (v) out[name] = v;
  }
  return out;
}

export interface KeyPresence {
  slot: string;
  present: boolean;
  /** Masked tail of the key in use; never the value. */
  masked?: string;
  source?: "pack" | "env";
  /** The Pack's file is in use while the machine's environment also sets this key. */
  shadowsEnv?: boolean;
}

/** What each slot has on this machine: the Pack file wins over `env`. Reports only a mask, never a value. */
export function readKeyPresence(file: string, env: Record<string, string | undefined>): KeyPresence[] {
  const fileEnv = readFileEnv(file);
  const slots: { id: string }[] = PROVIDERS.flatMap((p) => [...p.slots]);
  return slots.map(({ id }): KeyPresence => {
    const name = SLOT_ENV[id]!;
    const packed = fileEnv.get(name);
    const own = env[name];
    if (packed) return { slot: id, present: true, masked: maskKey(packed), source: "pack", shadowsEnv: !!own };
    if (own) return { slot: id, present: true, masked: maskKey(own), source: "env", shadowsEnv: false };
    return { slot: id, present: false };
  });
}

export function createKeyStore(o: KeyStoreOptions): KeyHandler & { set(a: { slot: string; sealed: string; hostId: string; cmdId: string }): Promise<KeyResult> } {
  const now = o.now ?? Date.now;
  let seen: string[] | undefined;
  const loadSeen = (): string[] => {
    if (seen) return seen;
    try {
      const v = JSON.parse(readFileSync(o.seenFile, "utf8"));
      seen = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(-SEEN_MEMORY) : [];
    } catch {
      seen = [];
    }
    return seen;
  };
  const remember = (id: string) => {
    const s = loadSeen();
    s.push(id);
    if (s.length > SEEN_MEMORY) s.splice(0, s.length - SEEN_MEMORY);
    try {
      const fd = openSync(o.seenFile, "w", 0o600);
      try {
        writeSync(fd, JSON.stringify(s.slice(-SEEN_PERSIST)));
      } finally {
        closeSync(fd);
      }
    } catch {
      /* in-memory protection still holds */
    }
  };

  function writeEnv(map: Map<string, string>): void {
    if (o.createDirs !== false) mkdirSync(dirname(o.file), { recursive: true });
    // Keep unrelated lines (comments, other variables) as they were.
    const lines = existsSync(o.file) ? readFileSync(o.file, "utf8").split("\n") : [];
    const out: string[] = [];
    const done = new Set<string>();
    for (const line of lines) {
      const mm = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      if (!mm || !Object.values(SLOT_ENV).includes(mm[1]!)) {
        if (line !== "" || out.length < lines.length - 1) out.push(line);
        continue;
      }
      if (map.has(mm[1]!) && !done.has(mm[1]!)) {
        out.push(`${mm[1]}=${map.get(mm[1]!)}`);
        done.add(mm[1]!);
      }
    }
    for (const [k, v] of map) if (!done.has(k)) out.push(`${k}=${v}`);
    const text = out.filter((l, i) => l !== "" || i < out.length - 1).join("\n");
    const tmp = `${o.file}.${process.pid}.tmp`;
    const mode = o.mode ?? 0o600;
    rmSync(tmp, { force: true }); // a stale temp from a crashed write
    try {
      const fd = openSync(tmp, "wx", mode); // created with the final mode: never briefly wider
      try {
        writeSync(fd, text ? text + "\n" : "");
        chmodSync(tmp, mode); // umask can only have narrowed it
        // Keep the old file's group (sfo-01 shares it with the readers); only the owner's own groups are allowed, so EPERM is fine.
        if (existsSync(o.file)) {
          try {
            chownSync(tmp, -1, statSync(o.file).gid);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
          }
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, o.file);
      const dfd = openSync(dirname(o.file), "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  const packMap = (): Map<string, string> => {
    const all = readFileEnv(o.file);
    const slots = new Map<string, string>();
    for (const v of Object.values(SLOT_ENV)) if (all.has(v)) slots.set(v, all.get(v)!);
    return slots;
  };

  return {
    async set({ slot, sealed, hostId, cmdId }) {
      const name = SLOT_ENV[slot];
      if (!name) return { ok: false, code: "rejected_key", message: "unknown key slot" };
      let opened: { key: string; issuedAt: number };
      try {
        opened = await unseal(o.privateKeyPkcs8, sealed, { hostId, cmdId, slot });
      } catch {
        return { ok: false, code: "bad_seal", message: "the sealed key could not be opened (wrong machine, host, command or slot)" };
      }
      if (Math.abs(now() - opened.issuedAt) > SEAL_MAX_AGE_MS) return { ok: false, code: "replay", message: "the sealed key is too old or from the future: check your clock (and this machine's)" };
      if (loadSeen().includes(cmdId)) return { ok: false, code: "replay", message: "this command was already used" };
      remember(cmdId);
      const key = normalizeKey(opened.key);
      // Whatever the provider check says: the value goes into an env file a service reads, so nothing it would interpret (or any newline) may pass.
      if (!/^[\x21-\x7e]+$/.test(key) || /["'\\$#]/.test(key)) return { ok: false, code: "rejected_key", message: "the key contains characters that are not allowed in a key" };
      const checked = await o.checker.check(slot, key);
      if (!checked.ok) {
        if (checked.kind === "rejected") return { ok: false, code: "rejected_key", message: checked.reason };
        const who = providerForSlot(slot)?.name ?? "the provider";
        return { ok: false, code: "check_unreachable", message: `Couldn't reach ${who} to check the key (${checked.reason}); nothing changed` };
      }
      try {
        const m = packMap();
        m.set(name, key);
        writeEnv(m);
      } catch {
        return { ok: false, code: "store_failed", message: "could not write the key file" };
      }
      const restarted = await o.restartWolvesUsing(slot).catch(() => [] as RestartedWolf[]);
      return { ok: true, data: { restarted } };
    },
    /** Unsealed: a removal carries no secret, and has the same trust as the rest of the command channel (the hub's operator auth). */
    async remove({ slot }) {
      const name = SLOT_ENV[slot];
      if (!name) return { ok: false, code: "rejected_key", message: "unknown key slot" };
      try {
        const m = packMap();
        if (!m.delete(name)) return { ok: true, data: { restarted: [] } }; // nothing was removed: nothing to restart
        writeEnv(m);
      } catch {
        return { ok: false, code: "store_failed", message: "could not write the key file" };
      }
      const restarted = await o.restartWolvesUsing(slot).catch(() => [] as RestartedWolf[]);
      return { ok: true, data: { restarted } };
    },
  };
}
