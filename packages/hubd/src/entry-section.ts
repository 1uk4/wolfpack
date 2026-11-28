/**
 * Where did a curated entry land? Cheap, best-effort lookup for sweep_item: find the entry file under the hub KB's domains,
 * read the frontmatter `section:` line, and name it from the section tree snapshot. Never throws; undefined when unresolvable.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSections } from "@wolfpack/kb/librarian";
import type { KbRoots } from "@wolfpack/kb/shared";

export interface EntrySection {
  domain: string;
  section?: string;
  /** Section ids from the top of the tree down to `section`. */
  sectionPath?: string[];
  sectionTitle?: string;
}

const SAFE_ID = /^[A-Za-z0-9_.-]{1,128}$/;

export function resolveEntrySection(roots: KbRoots, entryId: string): EntrySection | undefined {
  try {
    if (!SAFE_ID.test(entryId)) return undefined;
    const domainsDir = join(roots.kbBase, "domains");
    for (const domain of readdirSync(domainsDir)) {
      const file = join(domainsDir, domain, "entries", `${entryId}.md`);
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, "utf8");
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw.replace(/^\uFEFF/, ""));
      const section = fm ? (/^section:[ \t]*([^\r\n]*?)[ \t\r]*$/m.exec(fm[1]!)?.[1] ?? "").replace(/^(["'])(.*)\1$/, "$2") : "";
      if (!section) return { domain };
      let sectionTitle: string | undefined;
      let sectionPath: string[] | undefined;
      try {
        const all = readSections(roots);
        const byId = new Map(all.map((s) => [String(s.id), s]));
        const t = byId.get(section)?.title;
        if (typeof t === "string" && t) sectionTitle = t;
        const chain: string[] = [];
        for (let cur = byId.get(section); cur && chain.length < 12 && !chain.includes(String(cur.id)); cur = cur.parent ? byId.get(String(cur.parent)) : undefined) chain.unshift(String(cur.id));
        if (chain.length) sectionPath = chain;
      } catch { /* the name and chain are optional */ }
      return { domain, section, ...(sectionPath ? { sectionPath } : {}), ...(sectionTitle ? { sectionTitle } : {}) };
    }
  } catch { /* best effort */ }
  return undefined;
}
