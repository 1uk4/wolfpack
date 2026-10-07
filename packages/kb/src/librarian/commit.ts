/**
 * commit — all file I/O for a sweep. Pure code. Entries are written FLAT;
 * classification lives in frontmatter so crystallization never moves files.
 */
import { existsSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWrite, renderEntry, type Entry } from "@wolfpack/engine";
import {
  type KbRoots,
  type ParsedContribution,
  entriesDir,
  receiptsDir,
  rejectedDir,
  unclassifiedDir,
  now,
} from "../shared/index.js";

/** Write (or overwrite) a curated entry, flat under its domain. */
export function commitEntry(roots: KbRoots, entry: Entry): void {
  const dir = entriesDir(roots, entry.frontmatter.domain);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${entry.frontmatter.id}.md`), renderEntry(entry));
}

/** Read an existing entry's raw markdown for merge input. */
export function readEntryMarkdown(
  roots: KbRoots,
  domain: string,
  id: string
): string | null {
  const path = join(entriesDir(roots, domain), `${id}.md`);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

export function writeReceipt(
  roots: KbRoots,
  wolf: string,
  c: ParsedContribution,
  outcome: string,
  detail: string
): void {
  const dir = receiptsDir(roots, wolf);
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    `from: ${c.from}`,
    `den_topic_id: ${c.denTopicId}`,
    `outcome: ${outcome}`,
    `processed: ${now()}`,
    "---",
    "",
    detail,
    "",
  ].join("\n");
  atomicWrite(join(dir, `${c.denTopicId}-${c.contentHash.slice(7, 17)}.md`), body);
}

/** Move a handled contribution out of the inbox into a sibling _processed/. */
export function markProcessed(c: ParsedContribution): void {
  if (!existsSync(c.filePath)) return;
  const dir = join(dirname(c.filePath), "_processed");
  mkdirSync(dir, { recursive: true });
  renameSync(c.filePath, join(dir, basename(c.filePath)));
}

/**
 * Quarantine a contribution that fits no declared domain. Entry-first still
 * holds (committed immediately) but into a Dewey-only holding area that is NEVER
 * mirrored — pending a human `wolfpack domain add`. Records the suggested name.
 */
export function quarantine(
  roots: KbRoots,
  c: ParsedContribution,
  suggestedDomain: string,
): void {
  const dir = unclassifiedDir(roots);
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    `from: ${c.from}`,
    `den_topic_id: ${c.denTopicId}`,
    `suggested_domain: ${suggestedDomain}`,
    `content_hash: ${c.contentHash}`,
    `quarantined: ${now()}`,
    "---",
    "",
    c.summary,
    "",
    c.body,
    "",
  ].join("\n");
  atomicWrite(join(dir, `${c.denTopicId}-${c.contentHash.slice(7, 17)}.md`), body);
}

/** Never silently drop a rejected contribution — archive it for audit. */
export function archiveRejected(
  roots: KbRoots,
  wolf: string,
  c: ParsedContribution
): void {
  const dir = rejectedDir(roots, wolf);
  mkdirSync(dir, { recursive: true });
  if (existsSync(c.filePath)) {
    atomicWrite(
      join(dir, `${c.denTopicId}-${c.contentHash.slice(7, 17)}.md`),
      readFileSync(c.filePath, "utf-8")
    );
  }
}

/** Single commit per sweep. Best-effort; no-op if not a git repo. */
export function gitCommit(roots: KbRoots, message: string): void {
  try {
    execFileSync("git", ["-C", roots.kbBase, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", roots.kbBase, "commit", "-m", message], {
      stdio: "ignore",
    });
  } catch {
    /* not a git repo or nothing to commit — fine for scaffold */
  }
}
