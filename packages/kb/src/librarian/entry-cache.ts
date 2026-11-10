/**
 * Parsed-entry cache for the curator tick. A tick reads every entry file several times (vector scan, oversized-parent check,
 * INDEX and digest per touched domain); on a ~360-entry KB that is most of the synchronous time. Each file is read and parsed
 * once and reused while its path, mtimeMs, size, inode and ctimeMs are unchanged (ctime catches a same-size rewrite whose mtime was set back or fell in the same timestamp tick) (the same key `createEmbedder` uses for the vector cache).
 * Any other writer (a hub commit, an admin op) changes mtime or size, so the next read re-reads that file. Files that are gone
 * drop out: a vanished file is evicted on ENOENT, and `listEntryFiles` evicts everything it no longer lists.
 *
 * Every cached read gives what a fresh read gives. Callers must treat the returned values as read-only.
 */
import { readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import { anchorOf, groupDateOf, groupOf } from "./anchors.js";
import { entrySummary } from "./embed.js";

export interface CachedEntry {
  raw: string;
  fields: Record<string, unknown>;
  /** `entrySummary(raw)`, computed once per file version. */
  summary(): string;
  anchor(): string | undefined;
  group(): string | undefined;
  groupDate(): string | undefined;
}

interface Slot extends CachedEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  ctimeMs: number;
}

const cache = new Map<string, Slot>();

/** Run `fn` on first use and keep its result. A throw is not cached: the next call runs `fn` again (and throws again). */
export const once = <T>(fn: () => T): (() => T) => {
  let done = false;
  let v: T;
  return () => {
    if (!done) {
      v = fn();
      done = true;
    }
    return v;
  };
};

function load(raw: string, st: Stats): Slot {
  return {
    raw,
    fields: parseFrontmatter(raw).fields as Record<string, unknown>,
    mtimeMs: st.mtimeMs,
    size: st.size,
    ino: st.ino,
    ctimeMs: st.ctimeMs,
    summary: once(() => entrySummary(raw)),
    anchor: once(() => anchorOf(raw)),
    group: once(() => groupOf(raw)),
    groupDate: once(() => groupDateOf(raw)),
  };
}

/** The entry at `path`, read and parsed at most once per (mtimeMs, size, ino, ctimeMs). Undefined when the file does not exist. Other errors throw. */
export function readEntryCached(path: string): CachedEntry | undefined {
  try {
    const st = statSync(path);
    const hit = cache.get(path);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && hit.ino === st.ino && hit.ctimeMs === st.ctimeMs) return hit;
    const slot = load(readFileSync(path, "utf-8"), st);
    cache.set(path, slot);
    return slot;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      cache.delete(path);
      return undefined;
    }
    throw err;
  }
}

/** The `.md` file names in `dir` (readdir order), evicting cached entries of that directory that are no longer there. */
export function listEntryFiles(dir: string): string[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  const prefix = join(dir, "/");
  const live = new Set(files.map((f) => join(dir, f)));
  for (const key of cache.keys()) if (key.startsWith(prefix) && !key.slice(prefix.length).includes("/") && !live.has(key)) cache.delete(key);
  return files;
}

/** Test seam: forget everything (a cold read). */
export function clearEntryCache(): void {
  cache.clear();
}
