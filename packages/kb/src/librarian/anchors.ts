/**
 * Anchored subjects. A contribution may carry a stable subject key (its
 * `anchor`); it is routed by that key alone, never by similarity or the subject
 * check. The key lives in the entry's frontmatter (`anchor: <key>`): the entry
 * files are the KB's shared truth, so the key survives a ledger rebuild, reorg
 * (which only repaints `section:`) and cleanup, and is read straight from the
 * file whenever it is needed.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type KbRoots, ANCHOR_RE, entriesDir } from "../shared/index.js";


/** The anchor in an entry's markdown frontmatter, if any. */
export function anchorOf(markdown: string): string | undefined {
  const m = /^---\n([\s\S]*?)\n---/.exec(markdown);
  if (!m) return undefined;
  const line = /^anchor:[ \t]*(.+?)[ \t]*$/m.exec(m[1]);
  const key = line?.[1].replace(/^["']|["']$/g, "");
  return key && ANCHOR_RE.test(key) ? key : undefined;
}

const frontmatterOf = (markdown: string): string | undefined => /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1];

/** The group key in an entry's frontmatter (`group:`), if any: the anchor of the entry it is grouped under. */
export function groupOf(markdown: string): string | undefined {
  const fm = frontmatterOf(markdown);
  const key = fm && /^group:[ \t]*(.+?)[ \t]*$/m.exec(fm)?.[1].replace(/^["']|["']$/g, "");
  return key && ANCHOR_RE.test(key) ? key : undefined;
}

/** The ordering date within its group (`groupDate:`), if any. */
export function groupDateOf(markdown: string): string | undefined {
  const fm = frontmatterOf(markdown);
  return fm ? /^groupDate:[ \t]*(\d{4}-\d{2}-\d{2})\b/m.exec(fm)?.[1] : undefined;
}

/**
 * The entries grouped under `key` (their `group:`), oldest group date first,
 * then oldest created, then id.
 */
export function groupMembers(roots: KbRoots, domain: string, key: string): Array<{ id: string; groupDate: string; created: string }> {
  const dir = entriesDir(roots, domain);
  if (!existsSync(dir)) return [];
  const out: Array<{ id: string; groupDate: string; created: string }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    let md: string;
    try {
      md = readFileSync(join(dir, f), "utf-8");
    } catch {
      continue;
    }
    if (groupOf(md) !== key) continue;
    out.push({
      id: f.slice(0, -3),
      groupDate: groupDateOf(md) ?? "",
      created: /^created:[ \t]*(\S+)/m.exec(md)?.[1] ?? "",
    });
  }
  return out.sort((a, b) => a.groupDate.localeCompare(b.groupDate) || a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
}

/**
 * Every anchored entry of a domain: key -> entry id. Should two entries claim
 * a key (a merge target that outgrew its budget starts a new one), the newest
 * wins. `grouped` holds the entries that sit under another entry (`group:`).
 */
export function anchorIndex(roots: KbRoots, domain: string): { byKey: Map<string, string>; ids: Set<string>; grouped: Set<string> } {
  const dir = entriesDir(roots, domain);
  const byKey = new Map<string, string>();
  const ids = new Set<string>();
  const grouped = new Set<string>();
  if (!existsSync(dir)) return { byKey, ids, grouped };
  const newest = new Map<string, string>(); // key -> "created|id" of the current holder
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md")) continue;
    let md: string;
    try {
      md = readFileSync(join(dir, f), "utf-8");
    } catch {
      continue;
    }
    const id = f.slice(0, -3);
    if (groupOf(md)) grouped.add(id);
    const key = anchorOf(md);
    if (!key) continue;
    ids.add(id);
    const created = /^created:[ \t]*(\S+)/m.exec(md)?.[1] ?? "";
    const rank = `${created}|${id}`;
    if (!newest.has(key) || rank > newest.get(key)!) {
      newest.set(key, rank);
      byKey.set(key, id);
    }
  }
  return { byKey, ids, grouped };
}

/**
 * The entry an OLD graduation made for a work item: `kb-<domain>-<id>` for the
 * key `work-<domain>-<id>`. Null for any other key.
 */
export function oldHubFor(key: string, domain: string): string | null {
  const m = new RegExp(`^work-${domain}-([0-9A-Za-z]{7})$`).exec(key);
  return m ? `kb-${domain}-${m[1]}` : null;
}
