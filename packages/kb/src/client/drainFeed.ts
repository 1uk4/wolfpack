/**
 * drainFeed — the wolf's READ-notice footprint. Deterministic, no LLM.
 *
 * Notices now live INSIDE each domain folder (`domains/<domain>/_feed/`), which
 * the per-domain Syncthing mirror delivers only to that domain's subscribers.
 * So a wolf simply scans the `_feed/` of every domain it has access to — access
 * control is automatic (it only has folders for its subscribed domains).
 *
 * The mirror is receiveonly, so we CANNOT delete consumed notices (Syncthing
 * would revert them). Instead we track seen notices locally in
 * `denLocal/feed-seen.json`, keyed by entry id + updated time so a later UPDATE
 * to the same entry surfaces again.
 *
 * Called from the memory extension's before_agent_start hook.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import { type FeedNotice, type KbRoots } from "../shared/index.js";

interface SeenState {
  seen: string[];
}

function seenFile(roots: KbRoots): string {
  return join(roots.denLocal, "feed-seen.json");
}

function loadSeen(roots: KbRoots): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(seenFile(roots), "utf-8")) as SeenState;
    return new Set(raw.seen ?? []);
  } catch {
    return new Set();
  }
}

function saveSeen(roots: KbRoots, seen: Set<string>): void {
  mkdirSync(roots.denLocal, { recursive: true });
  // Cap growth: keep the most recent 2000 keys.
  const arr = [...seen].slice(-2000);
  writeFileSync(seenFile(roots), JSON.stringify({ seen: arr }));
}

/**
 * Drain feed notices across every domain the wolf can see. Returns only notices
 * not seen before (by entry id + updated time). When `consume` is true, those
 * are recorded as seen so they don't resurface next session.
 */
export function drainFeed(roots: KbRoots, consume = true): FeedNotice[] {
  const domainsRoot = join(roots.kbBase, "domains");
  if (!existsSync(domainsRoot)) return [];

  const seen = loadSeen(roots);
  const fresh: FeedNotice[] = [];

  for (const domain of readdirSync(domainsRoot, { withFileTypes: true })) {
    if (!domain.isDirectory()) continue;
    const feedDir = join(domainsRoot, domain.name, "_feed");
    if (!existsSync(feedDir)) continue;
    for (const file of readdirSync(feedDir).filter((f) => f.endsWith(".md"))) {
      try {
        const { fields } = parseFrontmatter(readFileSync(join(feedDir, file), "utf-8"));
        const entryId = String(fields.entry_id ?? "");
        const updated = String(fields.updated ?? "");
        const key = `${domain.name}/${entryId}:${updated}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({
          canonicalId: String(fields.canonical_id ?? ""),
          entryId,
          yourAlias: fields.your_alias ? String(fields.your_alias) : null,
          change: (fields.change as FeedNotice["change"]) ?? "updated",
          by: String(fields.by ?? ""),
          summary: String(fields.summary ?? ""),
          updated,
        });
      } catch {
        /* skip unreadable notice */
      }
    }
  }

  if (consume && fresh.length) saveSeen(roots, seen);
  return fresh;
}
