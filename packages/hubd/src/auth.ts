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
import { chmodSync, closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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
const LOCK_WAIT_MS = 2_000; // default for the CLI; hubd passes 0
const LAST_USED_FLUSH_MS = 5_000;
const RACY_MS = 2_000;
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
  /** What this code may become: fixed when the code is minted (`hubd pair --kind ... --host-id ...`). */
  kind?: TokenKind;
  hostId?: string;
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

/** Lock options. `waitMs` 0 = fail fast with `busy` (the hub, so it never stalls its event loop); the CLI waits a little. */
export interface LockOptions {
  waitMs?: number;
  staleMs?: number;
}

/**
 * Break a stale lock without ever letting two waiters both win: rename it to a name unique to this caller (atomic; exactly one
 * waiter's rename succeeds, the rest get ENOENT), then check what we moved really was stale. If a live lock slipped in between our
 * stat and our rename, put it back (link fails if yet another took the path). Returns true when WE removed a stale lock.
 */
export function tryBreakStaleLock(lock: string, staleMs: number): boolean {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= staleMs) return false;
  } catch {
    return false; // gone meanwhile
  }
  const moved = `${lock}.${randomBytes(8).toString("hex")}`;
  try {
    renameSync(lock, moved);
  } catch {
    return false; // another waiter won the break
  }
  try {
    if (Date.now() - statSync(moved).mtimeMs <= staleMs) {
      try {
        linkSync(moved, lock); // we grabbed a live lock: restore it
      } catch {
        /* someone else already took the path */
      }
      return false;
    }
    return true;
  } finally {
    try {
      unlinkSync(moved);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Cross-process exclusive lock: `<file>.lock` created O_EXCL holding a random nonce. A lock older than `staleMs` (holder died) is
 * broken via tryBreakStaleLock. Release removes the lock only while it still holds OUR nonce.
 */
function withLock<T>(file: string, fn: () => T, o: LockOptions = {}): T {
  const lock = `${file}.lock`;
  const waitMs = o.waitMs ?? LOCK_WAIT_MS;
  const staleMs = o.staleMs ?? LOCK_STALE_MS;
  mkdirSync(dirname(file), { recursive: true });
  const nonce = randomBytes(12).toString("hex");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, nonce);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (tryBreakStaleLock(lock, staleMs)) continue;
    if (Date.now() >= deadline) throw new HubError("busy", "token store is locked by another process; retry");
    sleepSync(Math.min(10 + Math.floor(Math.random() * 20), Math.max(1, deadline - Date.now())));
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lock, "utf8") === nonce) unlinkSync(lock);
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

export const HOST_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function createTokenStore(dataDir: string, now: () => number = Date.now, lockOpts: LockOptions = {}) {
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
    }, lockOpts);

  // verify(): parsed file cached by stamp.
  let cache: { stamp: string; tokens: TokenRecord[]; ok: boolean } | undefined;
  let warnedStamp = "";
  /** mtime/ctime in ns + size + inode (bigint), so a replaced file is not mistaken for the cached one. */
  const statStamp = (): { stamp: string; ageMs: number } => {
    try {
      const st = statSync(file, { bigint: true });
      return { stamp: `${st.mtimeNs}:${st.ctimeNs}:${st.size}:${st.ino}`, ageMs: Date.now() - Number(st.mtimeMs) };
    } catch {
      return { stamp: "none", ageMs: Infinity };
    }
  };
  const stamp = (): string => statStamp().stamp;
  /** `ok: false` = the file exists but is unreadable/corrupt (tokens read as none). */
  const readTokensState = (): { tokens: TokenRecord[]; ok: boolean } => {
    const { stamp: st, ageMs } = statStamp();
    if (cache?.stamp === st) return { tokens: cache.tokens, ok: cache.ok };
    let result: { tokens: TokenRecord[]; ok: boolean };
    try {
      result = { tokens: load(file).tokens, ok: true };
    } catch (e) {
      if (warnedStamp !== st) {
        warnedStamp = st;
        console.error(`hubd: ${file} is unreadable (${e instanceof Error ? e.message : String(e)}); all tokens are refused until it is fixed`);
      }
      result = { tokens: [], ok: false };
    }
    // Racy-git rule: a file modified within RACY_MS may change again without moving the stamp, so do not trust a cache of it.
    cache = ageMs >= RACY_MS ? { stamp: st, ...result } : undefined;
    return result;
  };
  const readTokens = (): TokenRecord[] => readTokensState().tokens;

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
    try {
      const state = readTokensState();
      if (!state.ok) return; // tokens.json unreadable: do not wipe last-used.json; keep the data in memory and retry on the next touch
      dirty = false;
      const live = new Set(state.tokens.map((t) => t.id));
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
    /** @internal TEST-ONLY: run `fn` under the store lock. */
    withLockForTest<T>(fn: () => T): T {
      return withLock(file, fn, lockOpts);
    },
    /** Mint a single-use pairing code (valid PAIRING_TTL_MS). Expired codes are pruned. */
    mintPairingCode(bind: { kind: TokenKind; hostId?: string }): { code: string; expiresAt: string } {
      if (bind.kind === "worker" && !bind.hostId) throw new HubError("invalid_request", "a worker pairing code needs a hostId");
      if (bind.kind !== "worker" && bind.hostId) throw new HubError("invalid_request", "only a worker pairing code takes a hostId");
      if (bind.hostId && !HOST_ID.test(bind.hostId)) throw new HubError("invalid_request", "hostId must be lower-case letters, digits and hyphens");
      const code = randomBytes(12).toString("base64url");
      const expiresAt = new Date(now() + PAIRING_TTL_MS).toISOString();
      mutate((s) => {
        s.pairings = s.pairings.filter((p) => Date.parse(p.expiresAt) > now());
        s.pairings.push({ hash: sha256(code), kind: bind.kind, ...(bind.hostId ? { hostId: bind.hostId } : {}), createdAt: new Date(now()).toISOString(), expiresAt });
      });
      return { code, expiresAt };
    },
    /**
     * Exchange a code for a token (atomic under the lock: a code redeems at most once). The token's kind and hostId come from the
     * CODE; `kind` / `hostId` in the request are optional and must match it. 401 for unknown/used/expired/mismatched (a mismatch
     * does not consume the code).
     */
    redeem(code: string, label: string, kind?: TokenKind, hostId?: string): { token: string; tokenId: string; kind: TokenKind; hostId?: string } {
      const token = randomBytes(32).toString("base64url");
      const tokenId = `tok-${randomBytes(5).toString("hex")}`;
      const h = sha256(code);
      return mutate((s) => {
        const live = s.pairings.filter((p) => Date.parse(p.expiresAt) > now());
        const hit = live.find((p) => eq(p.hash, h));
        s.pairings = live; // a prune changes the file; a miss without a prune does not
        if (!hit || !hit.kind) throw new HubError("unauthorized", "unknown, used or expired pairing code");
        if ((kind !== undefined && kind !== hit.kind) || (hostId !== undefined && hostId !== hit.hostId))
          throw new HubError("unauthorized", "this pairing code was issued for a different kind or host");
        s.pairings = live.filter((p) => p !== hit);
        s.tokens.push({ id: tokenId, hash: sha256(token), label, kind: hit.kind, ...(hit.hostId ? { hostId: hit.hostId } : {}), owner: OWNER, createdAt: new Date(now()).toISOString() });
        return { token, tokenId, kind: hit.kind, ...(hit.hostId ? { hostId: hit.hostId } : {}) };
      });
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
