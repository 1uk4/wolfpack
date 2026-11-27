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
      try {
        const t = readSections(roots).find((s) => String(s.id) === section)?.title;
        if (typeof t === "string" && t) sectionTitle = t;
      } catch { /* the name is optional */ }
      return { domain, section, ...(sectionTitle ? { sectionTitle } : {}) };
    }
  } catch { /* best effort */ }
  return undefined;
}
