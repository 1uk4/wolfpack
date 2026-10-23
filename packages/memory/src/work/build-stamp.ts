/**
 * Stale-build detection. A long-running pi session keeps the code it loaded at
 * start; a rebuild (or a git pull) afterwards leaves it running old logic. The
 * stamp is the newest mtime of the code files the graduation depends on: taken
 * once at load, compared with the disk when a preview is made.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Newest mtime (ms) of the non-test .js/.ts files in `dirs`; 0 when none exist. */
export function buildStamp(dirs: string[]): number {
  let newest = 0;
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.(?:js|ts)$/.test(f) || /\.test\.|\.d\.ts$/.test(f)) continue;
      newest = Math.max(newest, statSync(join(dir, f)).mtimeMs);
    }
  }
  return newest;
}

// Where this module lives. In a bundle (the pi-durable harness.cjs) there is no
// module URL and no source tree beside it: the check is then off, never a crash.
function moduleDir(): string | undefined {
  try {
    const url = import.meta.url;
    return url ? dirname(fileURLToPath(url)) : undefined;
  } catch {
    return undefined;
  }
}
const here = moduleDir();
/** Where this code lives: …/memory/<src|dist>/work. The graduation also uses kb's shared helpers. */
function codeDirs(root: string): string[] {
  if (!here) return [];
  const memory = join(here, "..", "..");
  return [join(memory, root, "work"), join(memory, "..", "kb", root, "shared")];
}
const runningRoot = here ? basename(dirname(here)) : ""; // "src" or "dist"

const LOADED = buildStamp(codeDirs(runningRoot));

/** A warning when the code on disk is newer than the code this process loaded, or the dist build lags src. */
export function staleBuildWarning(loaded = LOADED, dirs: { running?: string[]; src?: string[] } = {}): string | undefined {
  if (!here && !dirs.running) return undefined;
  const current = buildStamp(dirs.running ?? codeDirs(runningRoot));
  if (loaded && current > loaded + 1000) {
    return "this pi session loaded older code than what is on disk (e.g. the Delivered list); restart pi before graduating";
  }
  if (runningRoot === "dist") {
    const src = buildStamp(dirs.src ?? codeDirs("src"));
    if (src > current + 1000) return "the built code (dist) is older than the source; run `npm run build` and restart pi before graduating";
  }
  return undefined;
}
