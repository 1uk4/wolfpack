/**
 * Device-token store. `<dataDir>/auth/tokens.json` holds ONLY sha256 hashes of tokens and pairing codes (mode 0600, atomic rename).
 * Every operation re-reads the file, so the local CLI (`hubd pair`, `hubd tokens revoke`) and the running hubd see each other's
 * changes; the server additionally watches the file's stat to close SSE streams of revoked tokens.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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
/** The single owner identity for now (console/browser tokens act as this operator). */
export const OWNER = "owner";
const LAST_USED_THROTTLE_MS = 60_000;

export interface TokenRecord {
  id: string;
  hash: string;
  label: string;
  kind: TokenKind;
  /** The host a worker token belongs to (required for kind worker). */
  hostId?: string;
  owner: string;
  createdAt: string;
  lastUsedAt: string | null;
}
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
function save(file: string, s: StoreFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

/** The actor a token acts as: console/browser = the owner as operator; worker = its hostId as a `wolf` actor. */
export function actorOf(t: Pick<TokenRecord, "kind" | "hostId" | "owner">): Actor {
  return t.kind === "worker" ? { id: t.hostId ?? "unknown-host", kind: "wolf" } : { id: t.owner, kind: "operator" };
}

export function createTokenStore(dataDir: string, now: () => number = Date.now) {
  const file = tokensFile(dataDir);
  const update = <T>(fn: (s: StoreFile) => T): T => {
    const s = load(file);
    const out = fn(s);
    save(file, s);
    return out;
  };
  const lastWrite = new Map<string, number>();
  return {
    file,
    /** Mint a single-use pairing code (valid PAIRING_TTL_MS). Expired codes are pruned. */
    mintPairingCode(): { code: string; expiresAt: string } {
      const code = randomBytes(8).toString("base64url");
      const expiresAt = new Date(now() + PAIRING_TTL_MS).toISOString();
      update((s) => {
        s.pairings = s.pairings.filter((p) => Date.parse(p.expiresAt) > now());
        s.pairings.push({ hash: sha256(code), createdAt: new Date(now()).toISOString(), expiresAt });
      });
      return { code, expiresAt };
    },
    /** Exchange a code for a token. The code is consumed even if later steps fail. 401 for unknown/used/expired. */
    redeem(code: string, label: string, kind: TokenKind, hostId?: string): { token: string; tokenId: string } {
      if (kind === "worker" && !hostId) throw new HubError("invalid_request", "hostId is required for a worker token");
      const token = randomBytes(32).toString("base64url");
      const tokenId = `tok-${randomBytes(5).toString("hex")}`;
      const h = sha256(code);
      update((s) => {
        const live = s.pairings.filter((p) => Date.parse(p.expiresAt) > now());
        const hit = live.find((p) => eq(p.hash, h));
        s.pairings = live.filter((p) => p !== hit);
        if (!hit) {
          save(file, s); // persist the prune; throw below skips the outer save
          throw new HubError("unauthorized", "unknown, used or expired pairing code");
        }
        s.tokens.push({ id: tokenId, hash: sha256(token), label, kind, ...(hostId ? { hostId } : {}), owner: OWNER, createdAt: new Date(now()).toISOString(), lastUsedAt: null });
      });
      return { token, tokenId };
    },
    /** Resolve a bearer token (re-reads the file, so a revoke is effective at once). Constant-time hash comparison. */
    verify(token: string): TokenRecord | undefined {
      const h = sha256(token);
      let found: TokenRecord | undefined;
      for (const t of load(file).tokens) if (eq(t.hash, h) && !found) found = t;
      return found;
    },
    /** Record use, at most once a minute per token. */
    touch(id: string): void {
      const t = now();
      if (t - (lastWrite.get(id) ?? 0) < LAST_USED_THROTTLE_MS) return;
      lastWrite.set(id, t);
      try {
        const s = load(file); // fresh read right before the write: a concurrent revoke is not lost
        const rec = s.tokens.find((x) => x.id === id);
        if (!rec) return;
        rec.lastUsedAt = new Date(t).toISOString();
        save(file, s);
      } catch (e) {
        console.error("hubd: could not record token use:", e);
      }
    },
    list(): Omit<TokenRecord, "hash">[] {
      return load(file).tokens.map(({ hash: _h, ...rest }) => rest);
    },
    revoke(id: string): boolean {
      return update((s) => {
        const n = s.tokens.length;
        s.tokens = s.tokens.filter((t) => t.id !== id);
        return s.tokens.length < n;
      });
    },
    /** Cheap change detector (mtime/size/inode) for the server's revoke watcher. */
    stamp(): string {
      try {
        const st = statSync(file);
        return `${st.mtimeMs}:${st.size}:${st.ino}`;
      } catch {
        return "none";
      }
    },
  };
}
export type TokenStore = ReturnType<typeof createTokenStore>;
