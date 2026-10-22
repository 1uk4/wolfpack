/**
 * Safe path segments — contribution frontmatter arrives over Syncthing from
 * other wolves, so anything taken from it must be validated before it is
 * joined into a path.
 */

import { contentHash } from "./hash.js";

const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

export function isSafeSegment(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && SAFE_SEGMENT.test(value);
}

/** Return `value` if it is a single safe path segment, else throw. */
export function safeSegment(value: unknown, label = "path segment"): string {
  if (!isSafeSegment(value)) {
    throw new Error(`unsafe ${label}: ${JSON.stringify(String(value).slice(0, 80))} (allowed: A-Z a-z 0-9 . _ ~ -)`);
  }
  return value;
}

/**
 * A den topic id that is always a safe path segment. An id that is already safe
 * is returned unchanged (so existing topics keep their names); anything else is
 * slugged to kebab-case, and an id with nothing slug-able gets a stable one
 * derived from its text.
 */
export function toTopicId(raw: string): string {
  if (raw !== "." && raw !== ".." && SAFE_SEGMENT.test(raw)) return raw;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `topic-${hashHex(contentHash(raw)).slice(0, 10)}`;
}

const HASH_PREFIX = "sha256:";

/** Bare lowercase hex of a content hash, with or without the "sha256:" prefix. Throws if not hex. */
export function hashHex(hash: string): string {
  const hex = hash.startsWith(HASH_PREFIX) ? hash.slice(HASH_PREFIX.length) : hash;
  if (!/^[0-9a-fA-F]+$/.test(hex)) throw new Error(`invalid content hash: ${JSON.stringify(hash.slice(0, 80))}`);
  return hex.toLowerCase();
}

/** Short hash tag (10 hex chars) used in contribution/receipt file names. */
export function hashTag(hash: string): string {
  return hashHex(hash).slice(0, 10);
}
