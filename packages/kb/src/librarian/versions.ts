/**
 * versions — in-folder history for entries, no git needed.
 *
 *   <kbBase>/domains/<domain>/versions/<entry-id>/<ISO-timestamp>.md
 *   <kbBase>/domains/<domain>/versions/<entry-id>/<ISO-timestamp>-retired.md
 *
 * Every time an entry file is overwritten, its previous content is first kept
 * here; a retired entry is moved here instead of deleted. `versions/` is a
 * sibling of `entries/`, so everything that reads `entries/` never sees it,
 * and it rides the domain's Syncthing share with the rest of the folder.
 * Timestamps use `-` for `:` so the names are legal on every filesystem.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import { type KbRoots, entryVersionsDir } from "../shared/index.js";

export interface EntryVersion {
  /** File name without `.md`, e.g. `2026-10-22T17-01-31.042Z` or `…Z-retired`. */
  timestamp: string;
  retired: boolean;
  size: number;
  /** First non-empty line after the frontmatter (the title heading). */
  firstLine: string;
}

/** Frontmatter keys whose change is a real edit, not a placement change. */
const MEANINGFUL_KEYS = new Set(["title", "kind", "properties"]);

/**
 * The part of an entry that counts as content: the body (which holds the
 * summary) plus the title / kind / properties frontmatter blocks. Section,
 * placement, dates and hashes are excluded, so a reorg or a re-stamp is not
 * a new version.
 */
export function meaningfulContent(raw: string): string {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
  if (!m) return raw;
  const kept: string[] = [];
  let keep = false;
  for (const line of m[1].split("\n")) {
    const key = /^([A-Za-z_][\w-]*):/.exec(line);
    if (key) keep = MEANINGFUL_KEYS.has(key[1]);
    if (keep) kept.push(line);
  }
  return `${kept.join("\n")}\n---\n${m[2]}`;
}

function stamp(dir: string, suffix: string): string {
  let ms = Date.now();
  for (;;) {
    const name = new Date(ms).toISOString().replace(/:/g, "-") + suffix;
    if (!existsSync(join(dir, `${name}.md`))) return name;
    ms++;
  }
}

/** Sorted version file names (oldest first), `.md` stripped. */
function versionNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3))
    .sort();
}

/**
 * Keep `previous` as a version of the entry. Skipped when it is identical to
 * the latest snapshot. Returns the snapshot name, or null when skipped.
 */
export function snapshotEntry(roots: KbRoots, domain: string, entryId: string, previous: string): string | null {
  const dir = entryVersionsDir(roots, domain, entryId);
  const latest = versionNames(dir).at(-1);
  if (latest && readFileSync(join(dir, `${latest}.md`), "utf-8") === previous) return null;
  const name = stamp(dir, "");
  atomicWrite(join(dir, `${name}.md`), previous);
  return name;
}

/** Snapshot `previous` only if `next` differs from it in content, not just placement. */
export function snapshotIfChanged(
  roots: KbRoots,
  domain: string,
  entryId: string,
  previous: string,
  next: string,
): string | null {
  return meaningfulContent(previous) === meaningfulContent(next) ? null : snapshotEntry(roots, domain, entryId, previous);
}

/**
 * Retire: move the entry file into its versions folder. Nothing is destroyed.
 * A reason that names a survivor ("merged into <id>" / "moved to <id>") is
 * recorded in the copy's frontmatter (`retired`, `retiredInto`), so a wolf that
 * has the KB mirror but not the ledger can still follow the entry to it.
 */
export function archiveRetiredEntry(roots: KbRoots, domain: string, entryId: string, file: string, reason?: string): string {
  const dir = entryVersionsDir(roots, domain, entryId);
  mkdirSync(dir, { recursive: true });
  const name = stamp(dir, "-retired");
  const into = reason ? /\b(?:merged into|moved to)\s+(kb-[A-Za-z0-9-]+)/i.exec(reason)?.[1] : undefined;
  const raw = reason && into ? readFileSync(file, "utf-8") : null;
  if (raw && reason && /^---\n/.test(raw)) {
    const extra = `retired: ${JSON.stringify(reason)}\nretiredInto: ${into}`;
    atomicWrite(join(dir, `${name}.md`), raw.replace(/^---\n/, `---\n${extra}\n`));
    unlinkSync(file);
  } else {
    renameSync(file, join(dir, `${name}.md`));
  }
  return name;
}

export function listVersions(roots: KbRoots, domain: string, entryId: string): EntryVersion[] {
  const dir = entryVersionsDir(roots, domain, entryId);
  return versionNames(dir).map((timestamp) => {
    const file = join(dir, `${timestamp}.md`);
    const body = readFileSync(file, "utf-8").replace(/^---\n[\s\S]*?\n---\n?/, "");
    return {
      timestamp,
      retired: timestamp.endsWith("-retired"),
      size: statSync(file).size,
      firstLine: body.split("\n").find((l) => l.trim())?.trim() ?? "",
    };
  });
}

/** Read one version by full timestamp or unique prefix; null if none/ambiguous. */
export function readVersion(roots: KbRoots, domain: string, entryId: string, timestamp: string): string | null {
  const dir = entryVersionsDir(roots, domain, entryId);
  const names = versionNames(dir);
  const hits = names.includes(timestamp) ? [timestamp] : names.filter((n) => n.startsWith(timestamp));
  return hits.length === 1 ? readFileSync(join(dir, `${hits[0]}.md`), "utf-8") : null;
}
