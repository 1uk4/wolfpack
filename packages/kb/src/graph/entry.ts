/** One KB entry for the reader: body, frontmatter, outgoing wikilinks (with existence) and backlinks. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isSafeSegment } from "../shared/safe-path.js";
import { wikilinkTargets } from "../shared/knowledgeLint.js";
import type { KbRoots } from "../shared/paths.js";
import { listDomainDirs } from "./build.js";
import { parseMarkdown, readMarkdownDir, readRelations, str } from "./read.js";
import type { KbBacklink, KbEntryDetail } from "./types.js";

/** The entry `id`, or null when the id is not a safe segment or no domain holds it. Never joins an unvalidated id into a path. */
export function readKbEntry(roots: Pick<KbRoots, "kbBase">, id: string): KbEntryDetail | null {
  if (!isSafeSegment(id)) return null;
  const domains = listDomainDirs(roots.kbBase);
  let found: { domain: string; meta: Record<string, unknown>; body: string } | null = null;
  const known = new Set<string>();
  const others: Array<{ id: string; title: string; body: string; meta: Record<string, unknown> }> = [];

  for (const domain of domains) {
    const file = join(roots.kbBase, "domains", domain, "entries", `${id}.md`);
    if (!found && existsSync(file)) {
      try {
        const parsed = parseMarkdown(readFileSync(file, "utf-8"));
        if (Object.keys(parsed.meta).length > 0) found = { domain, ...parsed };
      } catch {
        /* unreadable: treated as absent */
      }
    }
    for (const e of readMarkdownDir(join(roots.kbBase, "domains", domain, "entries"))) {
      const eid = str(e.meta.id) ?? e.file.replace(/\.md$/, "");
      known.add(eid);
      others.push({ id: eid, title: str(e.meta.title) ?? eid, body: e.body, meta: e.meta });
    }
    try {
      for (const f of readdirSync(join(roots.kbBase, "domains", domain, "work"))) if (f.endsWith(".md")) known.add(f.replace(/\.md$/, ""));
    } catch {
      /* no work dir */
    }
  }
  if (!found) return null;

  const backlinks: KbBacklink[] = [];
  for (const o of others) {
    if (o.id === id) continue;
    if (wikilinkTargets(o.body).includes(id)) backlinks.push({ id: o.id, title: o.title, via: "wikilink" });
    for (const r of readRelations(o.meta)) if (r.target === id) backlinks.push({ id: o.id, title: o.title, via: "related", relation: r.kind });
  }
  backlinks.sort((a, b) => a.id.localeCompare(b.id) || a.via.localeCompare(b.via));

  return {
    id,
    title: str(found.meta.title) ?? id,
    domain: found.domain,
    frontmatter: found.meta,
    body: found.body,
    wikilinks: wikilinkTargets(found.body).map((target) => ({ target, exists: known.has(target) })),
    backlinks,
  };
}
