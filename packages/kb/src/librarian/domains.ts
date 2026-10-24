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
import { entrySummary } from "./embed.js";
import { anchorOf, groupDateOf, groupOf } from "./anchors.js";
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

/** Max chars of an INDEX line's summary. */
const INDEX_SUMMARY_MAX = 200;

/** One line, capped: the INDEX shows a glance, not the whole lede. */
function indexSummary(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > INDEX_SUMMARY_MAX ? one.slice(0, INDEX_SUMMARY_MAX - 1).trimEnd() + "…" : one;
}

interface GroupInfo {
  id: string;
  anchor?: string;
  group?: string;
  groupDate: string;
}

/**
 * `items` (already in their display order) with each grouped entry moved to sit
 * right after its holder (the entry anchored by its `group:` key), followers
 * ordered by group date. A grouped entry whose holder is not in `items` keeps
 * its own place. Returns the ordered items and the ids that are followers.
 */
export function orderGroups<T extends GroupInfo>(items: T[]): { ordered: T[]; followers: Set<string> } {
  const holderOf = new Map<string, string>();
  for (const i of items) if (i.anchor && !i.group) holderOf.set(i.anchor, i.id);
  const under = new Map<string, T[]>();
  const followers = new Set<string>();
  for (const i of items) {
    const h = i.group ? holderOf.get(i.group) : undefined;
    if (!h || h === i.id) continue;
    followers.add(i.id);
    under.set(h, [...(under.get(h) ?? []), i]);
  }
  const ordered: T[] = [];
  for (const i of items) {
    if (followers.has(i.id)) continue;
    ordered.push(i);
    const f = under.get(i.id);
    if (f) ordered.push(...[...f].sort((a, b) => a.groupDate.localeCompare(b.groupDate) || a.id.localeCompare(b.id)));
  }
  return { ordered, followers };
}

/**
 * Regenerate `domains/<domain>/INDEX.md` from the entries on disk. Deterministic
 * (reads each entry's frontmatter). Call for each domain touched in a sweep.
 */
export function renderDomainIndex(roots: KbRoots, domain: string): void {
  const dir = entriesDir(roots, domain);
  const rows: Array<GroupInfo & { title: string; summary: string; sub: string }> = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      try {
        const md = readFileSync(join(dir, f), "utf-8");
        const { fields } = parseFrontmatter(md);
        rows.push({
          id: f.replace(/\.md$/, ""),
          title: String(fields.title ?? f.replace(/\.md$/, "")),
          summary: indexSummary(entrySummary(md)),
          sub: String(fields.subcategory ?? ""),
          anchor: anchorOf(md),
          group: groupOf(md),
          groupDate: groupDateOf(md) ?? "",
        });
      } catch {
        /* skip unreadable entry */
      }
    }
  }
  rows.sort((a, b) => a.title.localeCompare(b.title));
  // Grouped entries are listed under their holder, indented, by group date.
  const { ordered, followers } = orderGroups(rows);

  const lines = [
    `# ${domain} — knowledge index`,
    "",
    `${rows.length} entr${rows.length === 1 ? "y" : "ies"}.`,
    "",
    // `[[id]]` wikilinks so the catalog is navigable in Obsidian. Filenames
    // equal ids, so each link resolves directly to the entry.
    ...ordered.map(
      (r) =>
        `${followers.has(r.id) ? "  " : ""}- [[${r.id}|${r.title}]]${r.sub ? ` _(${r.sub})_` : ""}${
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
  const groupInfo: GroupInfo[] = [];
  const dir = entriesDir(roots, domain);
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
      try {
        const md = readFileSync(join(dir, f), "utf-8");
        const { fields } = parseFrontmatter(md);
        const entryId = f.replace(/\.md$/, "");
        groupInfo.push({ id: entryId, anchor: anchorOf(md), group: groupOf(md), groupDate: groupDateOf(md) ?? "" });
        const currency = (fields.currency as Currency) ?? "live";
        const section = String(fields.section ?? "");
        entryMap.set(entryId, { currency, section });
      } catch {
        /* skip unreadable entry */
      }
    }
  }

  // Helper: get entry IDs for a section
  // (the holder first, then the entries grouped under it by group date)
  const getEntryIds = (sectionId: string): string[] => {
    const here = new Set(
      Array.from(entryMap.entries())
        .filter(([_, data]) => data.section === sectionId)
        .map(([id]) => id),
    );
    return orderGroups(groupInfo.filter((g) => here.has(g.id))).ordered.map((g) => g.id);
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
