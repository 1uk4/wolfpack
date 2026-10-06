/**
 * drainFeed — the wolf's READ-notice footprint. Deterministic, no LLM.
 *
 * Called from the memory extension's before_agent_start hook (same place den
 * topics are injected). Reads kb-feed notices, returns them for the caller to
 * cache onto linked den topics. Pointer + summary only — the full entry is
 * resolved on demand against the local kb-base mirror (see resolve.ts).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import { type FeedNotice, feedDir, type KbRoots } from "../shared/index.js";

/**
 * Drain all pending feed notices for a wolf. If `consume` is true, processed
 * notice files are removed after reading.
 */
export function drainFeed(
  roots: KbRoots,
  wolf: string,
  consume = true
): FeedNotice[] {
  const dir = feedDir(roots, wolf);
  if (!existsSync(dir)) return [];

  const notices: FeedNotice[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const path = join(dir, file);
    const { fields } = parseFrontmatter(readFileSync(path, "utf-8"));
    notices.push({
      canonicalId: String(fields.canonical_id ?? ""),
      entryId: String(fields.entry_id ?? ""),
      yourAlias: fields.your_alias ? String(fields.your_alias) : null,
      change: (fields.change as FeedNotice["change"]) ?? "updated",
      by: String(fields.by ?? ""),
      summary: String(fields.summary ?? ""),
      updated: String(fields.updated ?? ""),
    });
    if (consume) rmSync(path);
  }
  return notices;
}
