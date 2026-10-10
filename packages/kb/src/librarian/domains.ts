/**
 * Declared-domain gate + per-domain INDEX generation (Dewey side).
 *
 * The CLI deploys the declared-domain set to <KB_BASE>/domains.yaml. The sweep
 * may ONLY commit entries into declared domains; anything else is quarantined
 * (see commit.quarantine) and surfaced as a recommendation. This keeps the KB
 * from growing an unmirrored, unreviewed domain behind your back.
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parse as yamlParse } from "yaml";
import { atomicWrite, parseFrontmatter } from "@wolfpack/engine";
import { createHash } from "node:crypto";
import { ENTRY_KINDS, FACET_KEYS, RELATION_KINDS } from "@wolfpack/engine";
import { DIGEST } from "@wolfpack/engine";
import {
  type KbRoots,
  domainsRegistryFile,
  domainIndex,
  domainDigest,
  entriesDir,
  type ContextDigest,
  type DigestSection,
} from "../shared/index.js";
import { readSections, getRoots, buildParentIndex } from "./sections.js";
import type { Section, SectionId, Currency } from "../schema/knowledge.js";

/**
 * The declared domain names, or null when no registry is deployed (treated as
 * "unconstrained" for back-compat so a bare install still commits).
 */
export function readDeclaredDomains(roots: KbRoots): Set<string> | null {
  const file = domainsRegistryFile(roots);
  if (!existsSync(file)) return null;
  try {
    const parsed = (yamlParse(readFileSync(file, "utf-8")) ?? {}) as {
      domains?: Record<string, unknown>;
    };
    const names = Object.keys(parsed.domains ?? {});
    return new Set(names);
  } catch {
    return null;
  }
}

/** True when the domain is committable (declared, or no registry deployed). */
export function isDeclared(declared: Set<string> | null, domain: string): boolean {
  return declared === null || declared.has(domain);
}

/**
 * Regenerate `domains/<domain>/INDEX.md` from the entries on disk. Deterministic
 * (reads each entry's frontmatter). Call for each domain touched in a sweep.
 */
export function renderDomainIndex(roots: KbRoots, domain: string): void {
  const dir = entriesDir(roots, domain);
  const rows: Array<{ id: string; title: string; summary: string; sub: string }> = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      try {
        const { fields } = parseFrontmatter(readFileSync(join(dir, f), "utf-8"));
        rows.push({
          id: f.replace(/\.md$/, ""),
          title: String(fields.title ?? f.replace(/\.md$/, "")),
          summary: String(fields.summary ?? ""),
          sub: String(fields.subcategory ?? ""),
        });
      } catch {
        /* skip unreadable entry */
      }
    }
  }
  rows.sort((a, b) => a.title.localeCompare(b.title));

  const lines = [
    `# ${domain} — knowledge index`,
    "",
    `${rows.length} entr${rows.length === 1 ? "y" : "ies"}.`,
    "",
    // `[[id]]` wikilinks so the catalog is navigable in Obsidian. Filenames
    // equal ids, so each link resolves directly to the entry.
    ...rows.map(
      (r) =>
        `- [[${r.id}|${r.title}]]${r.sub ? ` _(${r.sub})_` : ""}${
          r.summary ? ` — ${r.summary}` : ""
        }`,
    ),
    "",
  ];
  mkdirSync(dir, { recursive: true });
  atomicWrite(domainIndex(roots, domain), lines.join("\n"));
}

/**
 * Regenerate `domains/<domain>/_digest.json` from the section tree and entries.
 * Deterministic, hierarchical projection of the KB. Hash-guarded write: only
 * rewrites the file if the content (excluding the `generated` timestamp) changed.
 */
export function renderDomainDigest(roots: KbRoots, domain: string): void {
  const sections = readSections(roots);
  const domainRoots = getRoots(sections, domain as any);
  const parentIndex = buildParentIndex(sections);

  // Read all entries for this domain to get their currency and section membership
  const entryMap = new Map<string, { currency: Currency; section: string }>();
  const dir = entriesDir(roots, domain);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      try {
        const { fields } = parseFrontmatter(readFileSync(join(dir, f), "utf-8"));
        const entryId = f.replace(/\.md$/, "");
        const currency = (fields.currency as Currency) ?? "live";
        const section = String(fields.section ?? "");
        entryMap.set(entryId, { currency, section });
      } catch {
        /* skip unreadable entry */
      }
    }
  }

  // Helper: get entry IDs for a section
  const getEntryIds = (sectionId: string): string[] => {
    return Array.from(entryMap.entries())
      .filter(([_, data]) => data.section === sectionId)
      .map(([id]) => id);
  };

  // Helper: roll up currency for a section (live > snapshot > archived)
  const rollupCurrency = (section: Section, children: DigestSection[]): Currency => {
    const directEntries = getEntryIds(section.id);
    const directCurrencies = directEntries.map((id) => entryMap.get(id)?.currency ?? "archived");
    const childCurrencies = children.map((c) => c.currency);
    const allCurrencies = [...directCurrencies, ...childCurrencies];

    if (allCurrencies.includes("live")) return "live";
    if (allCurrencies.includes("snapshot")) return "snapshot";
    return "archived";
  };

  // Recursive builder for DigestSection tree
  const buildDigestSection = (section: Section): DigestSection => {
    const childSections = parentIndex.get(section.id) ?? [];
    const children = childSections.map(buildDigestSection);
    const entryIds = getEntryIds(section.id);
    const currency = rollupCurrency(section, children);

    return {
      sectionId: section.id,
      title: section.title,
      summary: section.summary || "(no summary)",
      currency,
      entryIds,
      children,
    };
  };

  // Build the digest sections from the root sections, dropping empty subtrees:
  // a section whose entries all moved away (and has no non-empty child) carries
  // nothing to know, and reorg never re-summarizes it, so it would otherwise
  // linger in the digest and in wolves' <kb_access> forever.
  const prune = (s: DigestSection): DigestSection | null => {
    const children = s.children.map(prune).filter((c): c is DigestSection => c !== null);
    return s.entryIds.length > 0 || children.length > 0 ? { ...s, children } : null;
  };
  let digestSections = domainRoots
    .map(buildDigestSection)
    .map(prune)
    .filter((s): s is DigestSection => s !== null);

  // Respect maxTopics cap (count total sections in the tree)
  const countSections = (section: DigestSection): number => {
    return 1 + section.children.reduce((sum, child) => sum + countSections(child), 0);
  };
  const totalSections = digestSections.reduce((sum, s) => sum + countSections(s), 0);
  if (totalSections > DIGEST.maxTopics) {
    // Simple truncation strategy: keep only the first N root sections
    // A more sophisticated approach could prune by depth or importance
    let count = 0;
    digestSections = digestSections.filter((section) => {
      const sectionCount = countSections(section);
      if (count + sectionCount <= DIGEST.maxTopics) {
        count += sectionCount;
        return true;
      }
      return false;
    });
  }

  // Build the digest
  const digest: ContextDigest = {
    domain,
    generated: new Date().toISOString(),
    vocabulary: {
      kinds: [...ENTRY_KINDS],
      facetKeys: [...FACET_KEYS],
      relationKinds: [...RELATION_KINDS],
    },
    sections: digestSections,
    gaps: [],
  };

  // Hash-guard: compute content hash excluding the generated timestamp
  const digestForHashing = { ...digest, generated: "STABLE" };
  const contentHash = createHash("sha256")
    .update(JSON.stringify(digestForHashing), "utf-8")
    .digest("hex");

  // Check if we need to write (compare hash with existing file)
  const digestPath = domainDigest(roots, domain);
  let shouldWrite = true;
  if (existsSync(digestPath)) {
    try {
      const existing = JSON.parse(readFileSync(digestPath, "utf-8")) as ContextDigest;
      const existingForHashing = { ...existing, generated: "STABLE" };
      const existingHash = createHash("sha256")
        .update(JSON.stringify(existingForHashing), "utf-8")
        .digest("hex");
      shouldWrite = contentHash !== existingHash;
    } catch {
      // If we can't read the existing file, write it
      shouldWrite = true;
    }
  }

  if (shouldWrite) {
    const dir = entriesDir(roots, domain);
    mkdirSync(dir, { recursive: true });
    atomicWrite(digestPath, JSON.stringify(digest, null, 2));
  }
}
