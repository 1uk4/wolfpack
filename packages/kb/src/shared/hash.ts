/** Content hashing — pure code, drives idempotency + dedup. */
import { createHash } from "node:crypto";

/** sha256 of a string, prefixed. Stable across machines. */
export function contentHash(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf-8").digest("hex");
}
