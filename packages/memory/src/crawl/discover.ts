/**
 * discover — walk a source root and select files. Pure over the filesystem:
 * deterministic order (sorted relPath), no reading of bodies yet.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SourceFile } from "./schemas.js";

export interface DiscoverOptions {
  /** Glob-ish include patterns (default: ["**\/*.md"]). */
  include?: string[];
  /** Glob-ish exclude patterns, added to the defaults. */
  exclude?: string[];
}

/** Junk that is never knowledge, excluded by default. */
export const DEFAULT_EXCLUDES = [
  "**/.obsidian/**",
  "**/.stfolder/**",
  "**/node_modules/**",
  "**/.git/**",
  "**/.DS_Store",
  "**/TaskNotes/Views/**",
];

const DEFAULT_INCLUDES = ["**/*.md"];

/**
 * Convert a minimal glob (`**`, `*`, literal segments) into a RegExp anchored to
 * the full relative path. Supports the subset we actually use in plans.
 */
export function globToRegExp(glob: string): RegExp {
  // Normalize to forward slashes (relPaths are produced with "/").
  let g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // "**" → any chars incl. "/"; swallow an optional trailing slash.
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++;
      } else {
        // "*" → any chars except "/"
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchesAny(relPath: string, globs: RegExp[]): boolean {
  return globs.some((r) => r.test(relPath));
}

/** Recursively list every file under root, as "/"-joined relative paths. */
function walk(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(abs);
      } else if (e.isFile()) {
        const rel = relative(root, abs).split(sep).join("/");
        let bytes = 0;
        try {
          bytes = statSync(abs).size;
        } catch {
          /* unreadable — bytes stays 0 */
        }
        out.push({ absPath: abs, relPath: rel, bytes });
      }
    }
  }
  return out;
}

/**
 * Discover source files under `root`, applying include/exclude. Returns a
 * deterministic, lexicographically sorted list.
 */
export function discoverSources(
  root: string,
  opts: DiscoverOptions = {}
): SourceFile[] {
  const includes = (opts.include?.length ? opts.include : DEFAULT_INCLUDES).map(
    globToRegExp
  );
  const excludes = [...DEFAULT_EXCLUDES, ...(opts.exclude ?? [])].map(globToRegExp);

  return walk(root)
    .filter(
      (f) => matchesAny(f.relPath, includes) && !matchesAny(f.relPath, excludes)
    )
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}
