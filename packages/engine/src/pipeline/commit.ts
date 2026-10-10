/**
 * Commit — atomic file writes. Pure code, no LLM.
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

/** Atomic write — temp file + rename. Never leaves a half-written file. */
export function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}
