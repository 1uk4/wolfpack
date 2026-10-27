/** One KB entry for the reader: body, frontmatter, outgoing wikilinks (with existence) and backlinks. */
import { join } from "node:path";
import { isSafeSegment } from "../shared/safe-path.js";
import { wikilinkTargets } from "../shared/knowledgeLint.js";
import type { KbRoots } from "../shared/paths.js";
import { listDomainDirs } from "./build.js";
import { readMarkdownDir, readRelations, str } from "./read.js";
import type { KbBacklink, KbEntryDetail } from "./types.js";

/**
 * The entry `id` (the frontmatter id the graph emits, else the filename), or null when the id is not a safe segment
 * or no domain holds it. The id is only compared against what was read, never joined into a path.
 */
export function readKbEntry(roots: Pick<KbRoots, "kbBase">, id: string): KbEntryDetail | null {
  if (!isSafeSegment(id)) return null;
  const known = new Set<string>();
  const all: Array<{ id: string; domain: string; title: string; body: string; meta: Record<string, unknown> }> = [];

  for (const domain of listDomainDirs(roots.kbBase)) {
    const dir = join(roots.kbBase, "domains", domain);
    // same filters as the graph builder: a file without parseable frontmatter is not an entry
    for (const e of readMarkdownDir(join(dir, "entries"))) {
      if (Object.keys(e.meta).length === 0) continue;
      const eid = str(e.meta.id) ?? e.file.replace(/\.md$/, "");
      known.add(eid);
      all.push({ id: eid, domain, title: str(e.meta.title) ?? eid, body: e.body, meta: e.meta });
    }
    for (const w of readMarkdownDir(join(dir, "work"))) {
      if (w.meta.nodeType === "work") known.add(str(w.meta.id) ?? w.file.replace(/\.md$/, ""));
    }
  }
  const found = all.find((e) => e.id === id);
  if (!found) return null;

  const seen = new Set<string>();
  const backlinks: KbBacklink[] = [];
  const add = (b: KbBacklink) => {
    const key = `${b.id}\0${b.via}\0${b.relation ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      backlinks.push(b);
    }
  };
  for (const o of all) {
    if (o.id === id) continue;
    if (wikilinkTargets(o.body).includes(id)) add({ id: o.id, title: o.title, via: "wikilink" });
    for (const r of readRelations(o.meta)) if (r.target === id) add({ id: o.id, title: o.title, via: "related", relation: r.kind });
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  backlinks.sort((a, b) => cmp(a.id, b.id) || cmp(a.via, b.via) || cmp(a.relation ?? "", b.relation ?? ""));

  return {
    id,
    title: found.title,
    domain: found.domain,
    frontmatter: found.meta,
    body: found.body,
    wikilinks: wikilinkTargets(found.body).map((target) => ({ target, exists: known.has(target) })),
    backlinks,
  };
}
