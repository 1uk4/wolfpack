/**
 * Machine public keys (work-wolfpack-6EmU8pu). Each hello may carry `pubkey`; the hub keeps its fingerprint per host in
 * `<dataDir>/machine-keys.json` (public data only) and raises `changed` when a known host presents a different key, until a console acks it.
 * Accepted limit: the hub relays the public key to browsers, so a compromised hub could swap it; the change flag is the only defence here.
 * Sealed keys are never stored here or anywhere else in the hub.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keyFingerprint } from "@wolfpack/protocol";

export interface MachineKeyInfo {
  pubkey: string;
  fingerprint: string;
  changed: boolean;
}

export interface MachineKeys {
  /** A hello from `hostId` carried `pubkey`. */
  observe(hostId: string, pubkey: string): Promise<void>;
  /** The key the console should seal to; undefined when the host never sent one. */
  get(hostId: string): MachineKeyInfo | undefined;
  all(): Record<string, MachineKeyInfo>;
  /** Accept the key with this fingerprint for `hostId` (clears `changed`). "unknown" when the host has no key, "mismatch" when `fingerprint` is not the current one. */
  ack(hostId: string, fingerprint: string): "ok" | "unknown" | "mismatch";
}

export function createMachineKeys(dataDir: string): MachineKeys {
  const file = join(dataDir, "machine-keys.json");
  let state: Record<string, MachineKeyInfo> = {};
  if (existsSync(file)) {
    try {
      state = JSON.parse(readFileSync(file, "utf8")) as Record<string, MachineKeyInfo>;
    } catch {
      state = {}; // unreadable: start empty (next hello re-records; a change cannot be detected for that one reconnect)
    }
  }
  const save = () => {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    async observe(hostId, pubkey) {
      const cur = state[hostId];
      if (cur && cur.pubkey === pubkey) return;
      state[hostId] = { pubkey, fingerprint: await keyFingerprint(pubkey), changed: !!cur };
      save();
    },
    get: (h) => state[h],
    all: () => ({ ...state }),
    ack(h, fingerprint) {
      const cur = state[h];
      if (!cur) return "unknown";
      if (cur.fingerprint !== fingerprint) return "mismatch"; // the key changed again since the console looked
      if (cur.changed) {
        state[h] = { ...cur, changed: false };
        save();
      }
      return "ok";
    },
  };
}
