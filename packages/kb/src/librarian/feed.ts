/**
 * feed — Dewey → wolf fan-out. Pointer + summary only (lean dens). One notice
 * file per subscriber per changed entry, under their alias.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import { type FeedNotice, type KbRoots, domainFeedDir, now } from "../shared/index.js";

// Notices are written INSIDE the domain folder so Syncthing delivers them only
// to that domain's subscribers \u2014 Dewey needs no subscriber list.
export function emitFeed(
  roots: KbRoots,
  domain: string,
  notice: FeedNotice
): void {
  const dir = domainFeedDir(roots, domain);
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    `canonical_id: ${notice.canonicalId}`,
    `entry_id: ${notice.entryId}`,
    `your_alias: ${notice.yourAlias ?? "null"}`,
    `change: ${notice.change}`,
    `by: ${notice.by}`,
    `updated: ${notice.updated || now()}`,
    `summary: ${JSON.stringify(notice.summary)}`,
    "---",
    "",
  ].join("\n");
  atomicWrite(join(dir, `${notice.entryId}.md`), body);
}
