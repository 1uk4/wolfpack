/**
 * Device-token store. `<dataDir>/auth/tokens.json` holds ONLY sha256 hashes of tokens and pairing codes (mode 0600, atomic rename).
 *
 * Writers: every mutation of tokens.json (pair, redeem, revoke; the CLI and the running hubd) runs under a cross-process exclusive
 * lock (`tokens.json.lock`, O_EXCL, stale after 10s) and RE-READS the file inside it, so concurrent writers cannot lose updates.
 * `lastUsedAt` is NOT in tokens.json: it lives in `last-used.json`, written only by the running hubd (debounced), so a use
 * recorded by the hub can never resurrect a revoked token. Readers (`verify`) cache the parsed file by its stat stamp, so a
 * change by the CLI is seen on the next request. The server also watches the stamp to close SSE streams of revoked tokens.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Actor, TokenKind } from "@wolfpack/protocol";
import { HubError } from "./errors.js";
import { tokensFile } from "./layout.js";

/** Who a request is. Legacy-key requests have `legacy: true` and no tokenId/kind/hostId. */
export interface AuthIdentity {
  tokenId?: string;
  kind?: TokenKind;
  hostId?: string;
  owner: string;
  legacy?: true;
}

export const PAIRING_TTL_MS = 10 * 60 * 1000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;
const LAST_USED_FLUSH_MS = 5_000;
/** The single owner identity for now (console/browser tokens act as this operator). */
export const OWNER = "owner";

export interface TokenRecord {
  id: string;
  hash: string;
  label: string;
  kind: TokenKind;
  /** The host a worker token belongs to (required for kind worker). */
  hostId?: string;
  owner: string;
  createdAt: string;
}
/** A token as shown by `tokens list` (no hash); lastUsedAt merged from last-used.json. */
export type TokenView = Omit<TokenRecord, "hash"> & { lastUsedAt: string | null };
interface PairingRecord {
  hash: string;
  createdAt: string;
  expiresAt: string;
}
interface StoreFile {
  tokens: TokenRecord[];
  pairings: PairingRecord[];
}

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const eq = (a: string, b: string) => {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
};
const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Read + parse. Missing = empty. Corrupt = throws (a writer must never overwrite a file it could not read). */
function load(file: string): StoreFile {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { tokens: [], pairings: [] };
    throw e;
  }
  const j = JSON.parse(raw) as Partial<StoreFile>;
  return { tokens: Array.isArray(j.tokens) ? j.tokens : [], pairings: Array.isArray(j.pairings) ? j.pairings : [] };
}
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}
const save = (file: string, s: StoreFile) => writeAtomic(file, JSON.stringify(s, null, 2) + "\n");

/** Cross-process exclusive lock: create `<file>.lock` with O_EXCL, retry briefly, break a lock older than LOCK_STALE_MS. */
function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(lock, "wx", 0o600);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); // holder died
    } catch {
      /* released meanwhile */
    }
    if (Date.now() > deadline) throw new HubError("busy", "token store is locked by another process; retry");
    sleepSync(10 + Math.floor(Math.random() * 20));
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lock);
    } catch {
      /* already broken as stale */
    }
  }
}

/**
 * The actor a token acts as: console/browser = the owner as operator; worker = its hostId as a `wolf` actor.
 * LIMITATION: a worker token is attributed to its HOST, not to an individual wolf on that host (per-wolf attribution comes with the
 * link tickets). The server records tokenId + hostId beside every work write made with a token (auth/attribution.jsonl).
 */
export function actorOf(t: Pick<TokenRecord, "kind" | "hostId" | "owner">): Actor {
  return t.kind === "worker" ? { id: t.hostId ?? "unknown-host", kind: "wolf" } : { id: t.owner, kind: "operator" };
}

export function createTokenStore(dataDir: string, now: () => number = Date.now) {
  const file = tokensFile(dataDir);
  const lastUsedFile = join(dirname(file), "last-used.json");
  const mutate = <T>(fn: (s: StoreFile) => T): T =>
    withLock(file, () => {
      const s = load(file); // fresh, inside the lock
      const before = JSON.stringify(s);
      try {
        return fn(s);
      } finally {
        if (JSON.stringify(s) !== before) save(file, s); // also persists a prune when the op then throws
      }
    });

  // verify(): parsed file cached by stamp.
  let cache: { stamp: string; tokens: TokenRecord[] } | undefined;
  let warnedStamp = "";
  const stamp = (): string => {
    try {
      const st = statSync(file);
      return `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      return "none";
    }
  };
  const readTokens = (): TokenRecord[] => {
    const st = stamp();
    if (cache?.stamp === st) return cache.tokens;
    try {
      cache = { stamp: st, tokens: load(file).tokens };
      return cache.tokens;
    } catch (e) {
      if (warnedStamp !== st) {
        warnedStamp = st;
        console.error(`hubd: ${file} is unreadable (${e instanceof Error ? e.message : String(e)}); all tokens are refused until it is fixed`);
      }
      cache = { stamp: st, tokens: [] };
      return cache.tokens;
    }
  };

  // lastUsedAt: in memory, flushed (debounced) to last-used.json by the running hub only.
  const lastUsed = new Map<string, string>();
  let dirty = false;
  let timer: NodeJS.Timeout | undefined;
  const readLastUsed = (): Record<string, string> => {
    try {
      return JSON.parse(readFileSync(lastUsedFile, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    try {
      const live = new Set(readTokens().map((t) => t.id));
      const out: Record<string, string> = {};
      for (const [id, at] of Object.entries({ ...readLastUsed(), ...Object.fromEntries(lastUsed) })) if (live.has(id)) out[id] = at;
      writeAtomic(lastUsedFile, JSON.stringify(out) + "\n");
    } catch (e) {
      console.error("hubd: could not write last-used.json:", e);
    }
  };

  return {
    file,
    lastUsedFile,
    /** Mint a single-use pairing code (valid PAIRING_TTL_MS). Expired codes are pruned. */
    mintPairingCode(): { code: string; expiresAt: string } {
      const code = randomBytes(12).toString("base64url");
      const expiresAt = new Date(now() + PAIRING_TTL_MS).toISOString();
      mutate((s) => {
        s.pairings = s.pairings.filter((p) => Date.parse(p.expiresAt) > now());
        s.pairings.push({ hash: sha256(code), createdAt: new Date(now()).toISOString(), expiresAt });
      });
      return { code, expiresAt };
    },
    /** Exchange a code for a token (atomic under the lock: a code redeems at most once). 401 for unknown/used/expired. */
    redeem(code: string, label: string, kind: TokenKind, hostId?: string): { token: string; tokenId: string } {
      if (kind === "worker" && !hostId) throw new HubError("invalid_request", "hostId is required for a worker token");
      const token = randomBytes(32).toString("base64url");
      const tokenId = `tok-${randomBytes(5).toString("hex")}`;
      const h = sha256(code);
      mutate((s) => {
        const live = s.pairings.filter((p) => Date.parse(p.expiresAt) > now());
        const hit = live.find((p) => eq(p.hash, h));
        s.pairings = live.filter((p) => p !== hit); // changes the file only if something was pruned or consumed
        if (!hit) throw new HubError("unauthorized", "unknown, used or expired pairing code");
        s.tokens.push({ id: tokenId, hash: sha256(token), label, kind, ...(hostId ? { hostId } : {}), owner: OWNER, createdAt: new Date(now()).toISOString() });
      });
      return { token, tokenId };
    },
    /** Resolve a bearer token (cached by file stamp, so a revoke is seen on the next request). Corrupt file = undefined (401). */
    verify(token: string): TokenRecord | undefined {
      const h = sha256(token);
      let found: TokenRecord | undefined;
      for (const t of readTokens()) if (eq(t.hash, h) && !found) found = t;
      return found;
    },
    /** Record use: memory now, last-used.json shortly (debounced). Never touches tokens.json. */
    touch(id: string): void {
      lastUsed.set(id, new Date(now()).toISOString());
      dirty = true;
      timer ??= setTimeout(flush, LAST_USED_FLUSH_MS);
      timer.unref();
    },
    /** Ids of the live tokens (cached read; a corrupt file reads as none). */
    ids(): string[] {
      return readTokens().map((t) => t.id);
    },
    /** Write pending last-used data now (hub shutdown). */
    flush,
    list(): TokenView[] {
      const disk = readLastUsed();
      return load(file).tokens.map(({ hash: _h, ...rest }) => {
        const a = lastUsed.get(rest.id);
        const b = disk[rest.id];
        return { ...rest, lastUsedAt: a && (!b || a > b) ? a : b ?? null };
      });
    },
    revoke(id: string): boolean {
      return mutate((s) => {
        const n = s.tokens.length;
        s.tokens = s.tokens.filter((t) => t.id !== id);
        return s.tokens.length < n;
      });
    },
    /** Cheap change detector (mtime/size/inode) for the server's revoke watcher. */
    stamp,
  };
}
export type TokenStore = ReturnType<typeof createTokenStore>;
