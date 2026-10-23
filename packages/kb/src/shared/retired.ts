/**
 * Retired entries — resolving an entry id to the live entry that replaced it.
 * Pure file reads, shared by Dewey and the wolves (graduation runs on a wolf,
 * which has the KB mirror but not Dewey's ledger). What the mirror carries:
 *
 *  1. `versions/<id>/<stamp>-retired.md`: the retired entry itself. Retirements
 *     made since this was added record `retiredInto: <survivor id>` in its
 *     frontmatter (see archiveRetiredEntry); older ones do not.
 *  2. `_registry.md`: den topic → entries. A retired entry has no row, but the
 *     work item whose graduation created it does (its den topic aliases the
 *     survivor), which is the fallback for retirements without `retiredInto`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type KbRoots, entriesDir, entryVersionsDir, domainRegistryFile } from "./paths.js";

/** Domain embedded in an entry id (`kb-<domain>-<7id>`), or null. */
export function entryIdDomain(id: string): string | null {
  return /^kb-([A-Za-z0-9-]+?)-[A-Za-z0-9]{7}$/.exec(id)?.[1] ?? null;
}

const isLive = (roots: KbRoots, id: string): boolean => {
  const d = entryIdDomain(id);
  return !!d && existsSync(join(entriesDir(roots, d), `${id}.md`));
};

/** The `-retired.md` copy of an entry in versions/, or null. */
function retiredCopy(roots: KbRoots, id: string): string | null {
  const d = entryIdDomain(id);
  if (!d) return null;
  const dir = entryVersionsDir(roots, d, id);
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((n) => n.endsWith("-retired.md")).sort().pop();
  return f ? readFileSync(join(dir, f), "utf-8") : null;
}

/** `retiredInto:` of a retired copy's frontmatter. */
export function retiredInto(markdown: string): string | undefined {
  const fm = /^---\n([\s\S]*?)\n---/.exec(markdown)?.[1] ?? "";
  return /^retiredInto:\s*["']?(kb-[A-Za-z0-9-]+)["']?\s*$/m.exec(fm)?.[1];
}

/** Den topic id → entry ids, from a domain's `_registry.md`. */
function registryTopics(roots: KbRoots, domain: string): Array<{ entries: string[]; aliases: string[] }> {
  const file = domainRegistryFile(roots, domain);
  if (!existsSync(file)) return [];
  const topics: Array<{ entries: string[]; aliases: string[] }> = [];
  for (const line of readFileSync(file, "utf-8").split("\n")) {
    if (line.startsWith("## ")) topics.push({ entries: [], aliases: [] });
    const t = topics[topics.length - 1];
    if (!t) continue;
    const e = /^- entries:\s*(.*)$/.exec(line);
    if (e) t.entries = e[1].split(",").map((s) => s.trim()).filter((s) => s.startsWith("kb-"));
    const a = /^\s+- [^:\s]+:(\S+)\s*\(/.exec(line);
    if (a) t.aliases.push(a[1]);
  }
  return topics;
}

/**
 * Map entry ids through the retire chain to their live survivors. A live id
 * stays. A retired one (it has a `-retired.md` copy and no live file) goes to
 * the entry its copy names, else to the single live entry the work item's den
 * topics now point at that is not already among `ids`; with no survivor it is
 * dropped. An id the mirror knows nothing about is kept (it may simply not
 * have synced yet). Result is unique, in order.
 */
export function resolveRetiredIds(roots: KbRoots, ids: string[], opts: { workId?: string } = {}): string[] {
  const out: string[] = [];
  const add = (id: string) => { if (!out.includes(id)) out.push(id); };
  const resolved = new Set(ids.filter((id) => isLive(roots, id) || !retiredCopy(roots, id)));
  for (const id of ids) {
    let cur = id;
    let copy: string | null = null;
    for (let hops = 0; hops < 5 && !isLive(roots, cur); hops++) {
      copy = retiredCopy(roots, cur);
      const next = copy ? retiredInto(copy) : undefined;
      if (!next) break;
      cur = next;
    }
    if (isLive(roots, cur) || !(copy ?? retiredCopy(roots, cur))) { add(cur); continue; }
    // Retired, with no recorded survivor: the work item's own topics.
    const d = entryIdDomain(cur);
    const wid = opts.workId;
    const candidates = new Set<string>();
    if (d && wid) {
      for (const t of registryTopics(roots, d)) {
        if (!t.aliases.some((a) => a === wid || a.startsWith(`${wid}~`))) continue;
        for (const e of t.entries) if (isLive(roots, e) && !resolved.has(e) && !ids.includes(e)) candidates.add(e);
      }
    }
    if (candidates.size === 1) add([...candidates][0]);
  }
  return out;
}
