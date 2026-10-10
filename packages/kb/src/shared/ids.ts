/** Id generation — stable, prefixed, collision-resistant. */
import { randomBytes } from "node:crypto";

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** A short nanoid-style token (default 7 chars, matching kb-<domain>-<id>). */
export function shortId(len = 7): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** Entry id: kb-<domain>-<shortId>. */
export function entryId(domain: string): string {
  return `kb-${domain}-${shortId()}`;
}

/** WorkItem id: work-<domain>-<shortId>. The Factory counterpart of entryId. */
export function workId(domain: string): string {
  return `work-${domain}-${shortId()}`;
}

/** Ledger event id: ev-<shortId>. */
export function eventId(): string {
  return `ev-${shortId(10)}`;
}

/** Current timestamp as "YYYY-MM-DD HH:MM". */
export function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 16);
}
