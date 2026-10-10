/**
 * progress — what the sweep is working on right now, for `wolfpack-kb status`.
 * A den-local file written when an item starts and removed when it ends.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { KbRoots } from "../shared/index.js";

export interface CurrentItem {
  from: string;
  denTopicId: string;
  /** Epoch ms the item started. */
  startedAt: number;
  /** Route decision once known, e.g. "merge → kb-x (12000 chars)". */
  route?: string;
}

const currentFile = (roots: KbRoots) => join(roots.denLocal, "sweep-current.json");

export function writeCurrent(roots: KbRoots, item: CurrentItem): void {
  mkdirSync(dirname(currentFile(roots)), { recursive: true });
  writeFileSync(currentFile(roots), JSON.stringify(item));
}

export function clearCurrent(roots: KbRoots): void {
  try {
    unlinkSync(currentFile(roots));
  } catch {
    /* already gone */
  }
}

export function readCurrent(roots: KbRoots): CurrentItem | null {
  try {
    return JSON.parse(readFileSync(currentFile(roots), "utf-8"));
  } catch {
    return null;
  }
}

/** The longest-waiting inbox contribution (by arrival time on this host). */
export function oldestInbox(roots: KbRoots): { wolf: string; file: string; ageMs: number } | null {
  const inbox = join(roots.opsRoot, "inbox");
  if (!existsSync(inbox)) return null;
  let oldest: { wolf: string; file: string; ageMs: number } | null = null;
  for (const d of readdirSync(inbox, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const file of readdirSync(join(inbox, d.name)).filter((f) => f.endsWith(".md"))) {
      const ageMs = Date.now() - statSync(join(inbox, d.name, file)).mtimeMs;
      if (!oldest || ageMs > oldest.ageMs) oldest = { wolf: d.name, file, ageMs };
    }
  }
  return oldest;
}

/** "45s", "12m 5s", "3h 2m". */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
