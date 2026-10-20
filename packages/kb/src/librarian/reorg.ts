/**
 * reorg — section maintenance: split overflows, merge underfull, crystallize unplaced.
 * 
 * Extracted from cli.ts for reuse by the harness sweep worker.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import type { Engine } from "@wolfpack/engine";
import type { KbRoots } from "../shared/index.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";
import { readSections, writeSections, foldSections } from "./sections.js";
import { readLedger, appendLedger, foldRegistry } from "./ledger.js";
import { renderDomainDigest, renderDomainIndex } from "./domains.js";
import { renderRegistry } from "./registry.js";
import {
  shouldMerge,
  type EntryWithVector,
} from "./hierarchy.js";
import { labelSection, sectionSummary, type SectionMember } from "./summarize.js";
import { buildTreeBottomUp, splitAsParentChild, placeEntry, checkInvariants } from "./section-tree.js";
import { SECTION_TREE } from "@wolfpack/engine";
import { createEmbedder, buildEntryVectors, cosine, type EntryVector } from "./embed.js";
import { computeCentroid } from "./hierarchy.js";
import { ev, type KbEvent } from "../shared/index.js";
import { withKbLock } from "./lock.js";

/**
 * Shared state threaded through every rebuild phase. `sections` is NOT in
 * here because phases that filter the array need to return a replacement;
 * everything else (result, allAssignments) is mutated in place.
 */
interface RebuildCtx {
  opts: ReorgOptions;
  domainsRoot: string;
  allVectors: EntryVector[];
  result: ReorgResult;
  allAssignments: Map<string, Map<string, SectionId>>;
  stConfig: typeof SECTION_TREE;
}

/** Shared state for a single incremental `reorgDomain` call. */
interface IncrementalCtx {
  opts: ReorgOptions;
  domainsRoot: string;
  allVectors: EntryVector[];
  result: ReorgResult;
  events: KbEvent[];
}

export interface ReorgOptions {
  engine: Engine;
  roots: KbRoots;
  /** Only reorg these domains (default: all) */
  domains?: string[];
  /** Only check these sections (for post-sweep targeted reorg) */
  touchedSections?: Set<string>;
  /** Full bottom-up rebuild of the section tree (agglomerative clustering) */
  rebuild?: boolean;
  /** No disk writes, no ledger appends, no LLM labeling — logging only. */
  dryRun?: boolean;
  /** Treat every section as dirty (re-label all, not just changed ones). */
  resummarizeAll?: boolean;
  notify?: (msg: string) => void;
}

export interface ReorgResult {
  splits: number;
  merges: number;
  crystallized: number;
  placements: number;
  labelsUpdated: number;
  domains: string[];
  /** Set when a full rebuild was performed */
  rebuilt?: boolean;
}

function mkSectionId(domain: string): SectionId {
  const chars = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let tail = "";
  for (let i = 0; i < 6; i++) tail += chars[Math.floor(Math.random() * chars.length)];
  return `sec-${domain}-${tail}` as unknown as SectionId;
}

/**
 * Rewrite an entry file's `section:` frontmatter field. No-op if the file is
 * missing or if `dryRun` is set. Single site for the pattern that was copy-
 * pasted ~15 times across the rebuild and incremental paths.
 */
function writeEntrySection(
  eDir: string,
  entryId: string,
  sectionId: SectionId | string,
  dryRun?: boolean,
): boolean {
  if (dryRun) return false;
  const file = join(eDir, `${entryId}.md`);
  if (!existsSync(file)) return false;
  const original = readFileSync(file, "utf-8");
  let content: string;
  if (/^section: .+$/m.test(original)) {
    // Replace existing section line.
    content = original.replace(/^section: .+$/m, `section: ${sectionId}`);
  } else if (/^domain: .+$/m.test(original)) {
    // Insert immediately after the `domain:` line so section lands inside
    // the frontmatter block. This handles entries whose frontmatter was
    // created without a section field (e.g. by admin split operations).
    content = original.replace(/^(domain: .+)$/m, `$1\nsection: ${sectionId}`);
  } else {
    // No place to insert — fail loudly rather than silently returning true.
    throw new Error(
      `writeEntrySection: ${entryId}.md has neither a 'section:' nor a 'domain:' line; cannot assign section ${sectionId}`,
    );
  }
  if (content === original) {
    // Should never happen now, but guard against a silent no-op.
    throw new Error(`writeEntrySection: ${entryId}.md unchanged after assignment to ${sectionId}`);
  }
  writeFileSync(file, content);
  return true;
}

/**
 * Scan an entries/ directory for files whose frontmatter `section:` field
 * matches `sectionId`. Returns the entry ids (filename without .md).
 *
 * Used as the ground-truth check before deleting a section: the in-memory
 * `memberCount` can lie (stale after mutations), but the disk never lies.
 */
function entriesPointingAt(eDir: string, sectionId: SectionId | string): string[] {
  if (!existsSync(eDir)) return [];
  const matches: string[] = [];
  for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
    const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
    if (String(fields.section ?? "") === String(sectionId)) {
      matches.push(f.replace(/\.md$/, ""));
    }
  }
  return matches;
}

/**
 * Scan an entries/ directory and return a map of sectionId -> count of
 * entry files whose frontmatter points at that section.
 */
function readSectionCounts(eDir: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!existsSync(eDir)) return counts;
  for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
    const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
    const sec = String(fields.section ?? "");
    if (sec) counts.set(sec, (counts.get(sec) ?? 0) + 1);
  }
  return counts;
}

/**
 * Set every domain section's memberCount to the actual count on disk. Used
 * after mutations so section.memberCount matches entry.frontmatter.section.
 */
function reconcileMemberCounts(
  sections: Section[],
  domain: string,
  eDir: string,
): void {
  const counts = readSectionCounts(eDir);
  for (const sec of sections.filter((s) => s.domain === domain)) {
    sec.memberCount = counts.get(sec.id as string) ?? 0;
  }
}

/**
 * True if any entry file in `eDir` has `section: <sectionId>` in its
 * frontmatter. Uses a text match (not a parse) because it's cheap and
 * fine for the collapse passes.
 */
function sectionHasEntriesOnDisk(eDir: string, sectionId: SectionId | string): boolean {
  if (!existsSync(eDir)) return false;
  for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
    const raw = readFileSync(join(eDir, f), "utf-8");
    if (raw.includes(`section: ${sectionId}`)) return true;
  }
  return false;
}

/**
 * Create a new Section with the structural boilerplate filled in. Avoids
 * 3 copies of the full Section literal spread across rebuild post-split and
 * incremental branching-factor control. All sections are born `dirty: true`
 * so the next label pass picks them up.
 */
function mkChildSection(args: {
  id: SectionId;
  domain: string;
  parent: SectionId | null;
  depth: number;
  centroid: number[];
  memberCount: number;
  childIds?: SectionId[];
}): Section {
  const today = new Date().toISOString().split("T")[0];
  return {
    id: args.id,
    domain: args.domain as DomainId,
    parent: args.parent,
    depth: args.depth,
    label: args.id.slice(-7) as any,
    title: "",
    centroid: args.centroid,
    memberCount: args.memberCount,
    childIds: args.childIds ?? [],
    summary: "",
    summaryHash: "",
    dirty: true,
    memberCountAtLastLabel: 0,
    created: today as any,
    updated: today as any,
  } as Section;
}

/**
 * Re-fold the ledger into the registry file. No-op if `dryRun`.
 */
function rerenderRegistry(roots: KbRoots, dryRun?: boolean): void {
  if (dryRun) return;
  const freshLog = readLedger(roots);
  renderRegistry(roots, foldRegistry(freshLog));
}

/**
 * Write sections.json and re-render per-domain digest + index. No-op if
 * `dryRun`. Called from both rebuild (early return) and incremental (bottom).
 */
/** Exported for tests. */
export function persistDomains(
  roots: KbRoots,
  sections: Section[],
  domains: string[],
  dryRun?: boolean,
): void {
  if (dryRun) return;
  // The snapshot holds every domain. Replace only the domains this run
  // worked on, so a stale in-memory copy of another domain never overwrites
  // that domain's current tree.
  const own = new Set(domains);
  const others = readSections(roots).filter((s) => !own.has(s.domain));
  writeSections(roots, [...others, ...sections.filter((s) => own.has(s.domain))]);
  for (const domain of domains) {
    renderDomainDigest(roots, domain);
    renderDomainIndex(roots, domain);
  }
}

/**
 * Collapse single-child chains at ANY depth: a section with 0 direct entries
 * and exactly 1 child adds no navigational value. Promote the child in place
 * (child inherits the chain-link's parent and depth, cascading down).
 *
 * Multi-child wrappers (0 direct + ≥2 children) are LEGITIMATE grouping nodes
 * from post-split and are kept. If a multi-child wrapper is dominated by one
 * child, promoteDominantChildren handles that separately.
 */
function collapseSingleChildChains(
  sections: Section[],
  domain: string,
  eDir: string,
  notify?: (msg: string) => void,
  dryRun?: boolean,
): Section[] {
  let out = sections;
  let collapsed = true;
  while (collapsed) {
    collapsed = false;
    for (const sec of out) {
      if (String(sec.domain) !== domain) continue;
      const actualChildren = out.filter((s) => s.parent === sec.id);
      if (actualChildren.length !== 1) continue;
      const only = actualChildren[0];

      // Verify-and-reassign: in-memory state says sec has 0 members and 1
      // child, but if any entries physically point at it on disk (stale
      // memberCount from an upstream mutation whose writeEntrySection may
      // have been dropped), reassign them to the only child before deleting.
      // With fix-1 to writeEntrySection this should never fire — but is kept
      // as a belt-and-suspenders invariant.
      const strays = entriesPointingAt(eDir, sec.id);
      if (strays.length > 0) {
        notify?.(`    reassigning ${strays.length} stray entries from chain-link "${sec.id}" → "${only.id}"`);
        for (const eid of strays) writeEntrySection(eDir, eid, only.id, dryRun);
        only.memberCount += strays.length;
        only.dirty = true;
      }
      only.parent = sec.parent;
      only.depth = sec.depth;
      const fixDepth = (parentId: SectionId, d: number): void => {
        for (const s of out) {
          if (s.parent === parentId) {
            s.depth = d;
            fixDepth(s.id, d + 1);
          }
        }
      };
      fixDepth(only.id, only.depth + 1);
      if (sec.parent) {
        const parent = out.find((s) => s.id === sec.parent);
        if (parent) {
          parent.childIds = parent.childIds.filter((c) => c !== sec.id);
          if (!parent.childIds.includes(only.id)) parent.childIds.push(only.id);
          parent.dirty = true;
        }
      }
      out = out.filter((s) => s.id !== sec.id);
      notify?.(`  collapse: single-child chain "${sec.title || sec.id}" at depth ${sec.depth}`);
      collapsed = true;
      break;
    }
  }
  return out;
}

/**
 * Read all `.md` entries from a directory and return title+summary pairs for
 * those whose `section:` frontmatter matches `sectionId`.
 */
function readDirectMembersFromDisk(
  eDir: string,
  sectionId: SectionId | string,
): SectionMember[] {
  const members: SectionMember[] = [];
  if (!existsSync(eDir)) return members;
  for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
    const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
    if (String(fields.section ?? "") === String(sectionId)) {
      members.push({
        title: String(fields.title ?? f.replace(/\.md$/, "")),
        summary: fields.summary ? String(fields.summary) : undefined,
      });
    }
  }
  return members;
}

/**
 * Run the LLM naming oracle for a single section and apply the result.
 * Returns true on success, false on exception. Caller is responsible for
 * the dry-run short-circuit, depth-cap guard, and any member collection.
 */
async function llmLabelSection(args: {
  engine: Engine;
  sec: Section;
  memberInfo: SectionMember[];
  sections: Section[];
  domain: string;
  withContext: boolean;
  touchUpdated: boolean;
  bubbleUp: boolean;
  logPrefix?: string;
  notify?: (msg: string) => void;
}): Promise<boolean> {
  const { engine, sec, memberInfo, sections, domain, notify } = args;
  const prefix = args.logPrefix ?? "labeled";
  const maxTreeDepth = Math.max(
    ...sections.filter((s) => s.domain === domain).map((s) => s.depth),
    0,
  );
  try {
    sec.summary = await sectionSummary(engine, memberInfo, {
      depth: sec.depth,
      maxDepth: maxTreeDepth,
    });
    const labelOpts: {
      sampleTitles: string[];
      depth: number;
      maxDepth: number;
      parentTitle?: string;
      siblingSummaries?: string[];
      domain?: string;
    } = {
      sampleTitles: memberInfo.map((m) => m.title),
      depth: sec.depth,
      maxDepth: maxTreeDepth,
      domain,
    };
    if (args.withContext) {
      const parent = sec.parent ? sections.find((s) => s.id === sec.parent) : null;
      labelOpts.parentTitle = parent?.title;
      labelOpts.siblingSummaries = sections
        .filter((s) => s.parent === sec.parent && s.id !== sec.id && s.domain === domain)
        .map((s) => s.summary);
    }
    sec.title = await labelSection(engine, sec.summary, labelOpts);
    sec.dirty = false;
    (sec as any).memberCountAtLastLabel = sec.memberCount;
    if (args.touchUpdated) {
      sec.updated = new Date().toISOString().split("T")[0] as any;
    }
    if (args.bubbleUp && sec.parent) {
      const parentSec = sections.find((s) => s.id === sec.parent);
      if (parentSec && !parentSec.dirty) parentSec.dirty = true;
    }
    notify?.(`  ${prefix}: ${sec.id} → "${sec.title}"`);
    return true;
  } catch (e) {
    notify?.(`  ${prefix} failed: ${sec.id}: ${e}`);
    return false;
  }
}

/**
 * Reorganize (or rebuild) the section tree. Holds the KB write lock for the
 * whole run, waiting up to 15 min for another sweep/reorg/rebuild to finish:
 * two writers at once overwrite each other's section trees.
 */
export async function reorg(opts: ReorgOptions): Promise<ReorgResult> {
  if (opts.dryRun) return reorgUnlocked(opts);
  return withKbLock(opts.roots, () => reorgUnlocked(opts), { waitMs: 15 * 60_000 });
}

async function reorgUnlocked(opts: ReorgOptions): Promise<ReorgResult> {
  const { engine, roots, notify } = opts;
  const domainsRoot = join(roots.kbBase, "domains");
  if (!existsSync(domainsRoot)) {
    return { splits: 0, merges: 0, crystallized: 0, placements: 0, labelsUpdated: 0, domains: [] };
  }

  const allDomains = readdirSync(domainsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const domains = opts.domains
    ? allDomains.filter((d) => opts.domains!.includes(d))
    : allDomains;

  if (domains.length === 0) return { splits: 0, merges: 0, crystallized: 0, placements: 0, labelsUpdated: 0, domains: [] };

  const log = readLedger(roots);
  const reg = foldRegistry(log);
  const embedder = createEmbedder(roots);
  const allVectors = await buildEntryVectors(roots, reg, embedder);
  // Read sections from file, or fold from ledger, or bootstrap from entry frontmatter
  let sections = readSections(roots);
  if (sections.length === 0 && log.length > 0) {
    sections = foldSections(log);
    if (sections.length > 0) {
      notify?.(`Bootstrapped ${sections.length} sections from ledger`);
    }
  }
  // Last resort: bootstrap from entry frontmatter + vectors
  if (sections.length === 0 && allVectors.length > 0) {
    const secMembers = new Map<string, typeof allVectors>();
    for (const v of allVectors) {
      const eDir = join(domainsRoot, v.domain, "entries");
      const file = join(eDir, `${v.entryId}.md`);
      if (!existsSync(file)) continue;
      const { fields } = parseFrontmatter(readFileSync(file, "utf-8"));
      const sec = String(fields.section ?? "");
      if (!sec) continue;
      if (!secMembers.has(sec)) secMembers.set(sec, []);
      secMembers.get(sec)!.push(v);
    }
    if (secMembers.size > 0) {
      const today = new Date().toISOString().split("T")[0];
      for (const [secId, members] of secMembers) {
        const domain = secId.replace(/^sec-/, "").replace(/-[^-]+$/, "");
        // Compute centroid from member vectors
        const dim = members[0]?.vector?.length ?? 768;
        const centroid = new Array(dim).fill(0);
        for (const m of members) {
          for (let i = 0; i < dim; i++) centroid[i] += (m.vector[i] ?? 0);
        }
        for (let i = 0; i < dim; i++) centroid[i] /= members.length;
        // Generate label from section ID
        const label = secId.replace(/^sec-[^-]+-/, "").toLowerCase();
        sections.push({
          id: secId,
          domain,
          parent: null,
          depth: 0,
          label,
          title: `Section ${label}`,
          centroid,
          memberCount: members.length,
          childIds: [],
          summary: `${members.length} entries`,
          summaryHash: "",
          dirty: true, memberCountAtLastLabel: 0,
          created: today,
          updated: today,
        } as unknown as Section);
      }
      notify?.(`Bootstrapped ${sections.length} sections from entry frontmatter`);
    }
  }
  const events: KbEvent[] = [];
  const result: ReorgResult = { splits: 0, merges: 0, crystallized: 0, placements: 0, labelsUpdated: 0, domains: [] };

  // Full bottom-up rebuild mode
  if (opts.rebuild) {
    const rctx: RebuildCtx = {
      opts, domainsRoot, allVectors, result,
      allAssignments: new Map(),
      stConfig: SECTION_TREE,
    };

    // 1. Build the tree.
    for (const domain of domains) {
      sections = await rebuildBootstrapDomain(domain, sections, rctx);
    }
    sections = rebuildAbsorbSingletonRoots(sections, rctx);
    sections = mergeSimilarRoots(sections, allVectors, result.domains, result, notify);
    for (const d of result.domains) reconcileMemberCounts(sections, d, join(domainsRoot, d, "entries"));
    await rebuildPostSplit(sections, rctx);
    sections = rebuildFinalAbsorb(sections, rctx);
    sections = promoteDominantChildren(sections, result.domains, domainsRoot, result, notify, opts.dryRun);
    for (const d of result.domains) reconcileMemberCounts(sections, d, join(domainsRoot, d, "entries"));

    // 2. Name the final tree (single bottom-up pass; grouping nodes sampled
    //    from descendant entries via the labeler's weighted-child fallback).
    await rebuildLabelAfter(sections, rctx);

    rerenderRegistry(roots, opts.dryRun);
    persistDomains(roots, sections, result.domains, opts.dryRun);

    notify?.(opts.dryRun
      ? `rebuild dry-run: ${result.placements} would be placed, ${result.labelsUpdated} would be labeled`
      : `rebuild done: ${result.placements} entries placed, ${result.labelsUpdated} sections labeled`);
    return result;
  }

  const ictx: IncrementalCtx = { opts, domainsRoot, allVectors, result, events };
  for (const domain of domains) {
    sections = await reorgDomain(domain, sections, ictx);
  }

  // Persist ledger first so the re-rendered registry sees the new events.
  if (!opts.dryRun && events.length > 0) appendLedger(roots, events);
  rerenderRegistry(roots, opts.dryRun);

  // Shared tail: run the same structural quality passes as rebuild so the
  // incremental path maintains the same tree invariants and we never need
  // to "rebuild to recover shape".
  sections = mergeSimilarRoots(sections, allVectors, result.domains, result, notify);
  sections = promoteDominantChildren(sections, result.domains, domainsRoot, result, notify, opts.dryRun);
  for (const domain of result.domains) {
    const eDir = join(domainsRoot, domain, "entries");
    sections = collapseSingleChildChains(sections, domain, eDir, notify, opts.dryRun);
  }

  persistDomains(roots, sections, result.domains, opts.dryRun);

  notify?.(opts.dryRun
    ? `reorg dry-run: ${result.splits} splits, ${result.merges} merges, ${result.crystallized} crystallized, ${result.labelsUpdated} labeled (no writes)`
    : `reorg done: ${result.splits} splits, ${result.merges} merges, ${result.crystallized} crystallized, ${result.labelsUpdated} labeled`);
  return result;
}


// ════════════════════════════════════════════════════════════════════════════
// Rebuild phases
// ════════════════════════════════════════════════════════════════════════════

/** Phase 1 — run buildTreeBottomUp per domain, write assignments, mark dirty. */
async function rebuildBootstrapDomain(
  domain: string,
  sections: Section[],
  ctx: RebuildCtx,
): Promise<Section[]> {
  const { opts, domainsRoot, allVectors, result, allAssignments, stConfig } = ctx;
  const { engine, notify } = opts;
  const domainVectors = allVectors.filter((v) => v.domain === domain);
  if (domainVectors.length === 0) {
    notify?.(`rebuild: ${domain} — no entries, skipping`);
    return sections;
  }
  notify?.(`rebuild: ${domain} (${domainVectors.length} entries)`);
  const domainCentroid = computeCentroid(domainVectors.map((v) => v.vector));
  const entries: EntryWithVector[] = domainVectors.map((v) => ({
    entryId: v.entryId,
    sectionId: "" as SectionId,
    vector: v.vector,
  }));
  // Entry metadata for abstraction scoring during clustering.
  const entryMeta = new Map<string, { kind?: string; maturity?: string }>();
  const entriesPath = join(domainsRoot, domain, "entries");
  if (existsSync(entriesPath)) {
    for (const f of readdirSync(entriesPath).filter((x) => x.endsWith(".md"))) {
      const { fields } = parseFrontmatter(readFileSync(join(entriesPath, f), "utf-8"));
      entryMeta.set(f.replace(/\.md$/, ""), {
        kind: fields.kind ? String(fields.kind) : undefined,
        maturity: fields.maturity ? String(fields.maturity) : undefined,
      });
    }
  }
  const treeResult = buildTreeBottomUp(entries, domain, domainCentroid, undefined, entryMeta);
  notify?.(`  built ${treeResult.sections.length} sections`);

  // Replace the old tree for this domain in place.
  sections = sections.filter((s) => s.domain !== domain);
  sections.push(...treeResult.sections);

  const eDir = join(domainsRoot, domain, "entries");
  let placed = 0;
  for (const [entryId, sectionId] of treeResult.assignments) {
    if (writeEntrySection(eDir, entryId, sectionId, opts.dryRun)) placed++;
  }
  notify?.(`  placed ${placed} entries into leaf sections`);
  for (const sec of treeResult.sections) sec.dirty = true;

  result.placements += placed;
  result.rebuilt = true;
  result.domains.push(domain);
  allAssignments.set(domain, treeResult.assignments);
  return sections;
}

/**
 * Phase 2 — absorb singleton roots (below the minRootRatio floor) into
 * their nearest neighbor. Stops before the domain drops below 2 roots.
 */
function rebuildAbsorbSingletonRoots(
  sections: Section[],
  ctx: RebuildCtx,
): Section[] {
  const { opts, domainsRoot, allVectors, result, allAssignments, stConfig } = ctx;
  const { engine, notify } = opts;
  for (const domain of result.domains) {
    const domVecs = allVectors.filter((v) => v.domain === domain);
    const totalEntries = domVecs.length;
    const minEntries = Math.max(2, Math.ceil(totalEntries * stConfig.minRootRatio));
    const domainRoots = sections.filter((s) => s.domain === domain && s.parent === null);
    const eDir = join(domainsRoot, domain, "entries");

    for (const root of domainRoots) {
      const currentRoots = sections.filter((s) => s.domain === domain && s.parent === null);
      if (currentRoots.length <= 2) break;
      if (root.memberCount >= minEntries) continue;
      if (root.childIds.length > 0) continue;

      const neighbors = domainRoots.filter(
        (r) => r.id !== root.id && (r.memberCount >= minEntries || r.childIds.length > 0),
      );
      if (neighbors.length === 0) continue;

      let bestNeighbor = neighbors[0];
      let bestSim = -1;
      for (const n of neighbors) {
        const sim = cosine(root.centroid, n.centroid);
        if (sim > bestSim) { bestSim = sim; bestNeighbor = n; }
      }

      notify?.(`  absorb: "${root.title || root.id}" (${root.memberCount}) → "${bestNeighbor.title || bestNeighbor.id}"`);

      const findLeaves = (parentId: SectionId): Section[] => {
        const children = sections.filter((s) => s.parent === parentId);
        if (children.length === 0) {
          const sec = sections.find((s) => s.id === parentId);
          return sec && sec.childIds.length === 0 ? [sec] : [];
        }
        return children.flatMap((c) => (c.childIds.length === 0 ? [c] : findLeaves(c.id)));
      };

      const domAssignments = allAssignments.get(domain) ?? new Map();
      for (const [entryId, secId] of domAssignments) {
        if (secId !== root.id) continue;
        const neighborLeaves = findLeaves(bestNeighbor.id);
        let targetSec = bestNeighbor.id;
        if (neighborLeaves.length > 0) {
          const entryVec = domVecs.find((v) => v.entryId === entryId)?.vector;
          if (entryVec) {
            let best = neighborLeaves[0];
            let bs = -1;
            for (const l of neighborLeaves) {
              const sim = cosine(entryVec, l.centroid);
              if (sim > bs) { bs = sim; best = l; }
            }
            targetSec = best.id;
            best.memberCount++;
          }
        } else {
          bestNeighbor.memberCount++;
        }
        domAssignments.set(entryId, targetSec);
        writeEntrySection(eDir, entryId, targetSec, opts.dryRun);
      }

      // Safety: catch any entries whose frontmatter still points at root but
      // weren't in allAssignments (e.g. new entries added since buildTreeBottomUp).
      const strays = entriesPointingAt(eDir, root.id);
      if (strays.length > 0) {
        notify?.(`    reassigning ${strays.length} stray entries from absorbed root "${root.id}" → "${bestNeighbor.id}"`);
        for (const eid of strays) writeEntrySection(eDir, eid, bestNeighbor.id, opts.dryRun);
        bestNeighbor.memberCount += strays.length;
      }

      sections = sections.filter((s) => s.id !== root.id);
      result.merges++;
    }
  }
  return sections;
}

/**
 * Final phase — label every dirty section in a single bottom-up pass.
 * Grouping nodes (0 direct entries) fall back to weighted sampling of
 * descendant entry titles so the LLM has real content to generalize from.
 * Runs AFTER post-split and final-absorb so the tree shape is final.
 */
async function rebuildLabelAfter(
  sections: Section[],
  ctx: RebuildCtx,
): Promise<void> {
  const { opts, domainsRoot, allVectors, result, allAssignments, stConfig } = ctx;
  const { engine, notify } = opts;
  for (const domain of result.domains) {
    const eDir = join(domainsRoot, domain, "entries");
    const dirtySections = sections
      .filter((s) => s.domain === domain && s.dirty)
      .sort((a, b) => b.depth - a.depth);
    notify?.(`  labeling ${dirtySections.length} sections (depth ${Math.max(...dirtySections.map(s => s.depth))} → 0)...`);

    for (const sec of dirtySections) {
      const memberInfo: SectionMember[] = readDirectMembersFromDisk(eDir, sec.id);

      // For wrappers (0 direct members), weight-sample from each child's
      // descendants so all branches contribute to the label prompt.
      if (memberInfo.length === 0 && sec.childIds.length > 0) {
        const collectEntriesFromSection = (sectionId: SectionId, max: number): SectionMember[] => {
          const result: SectionMember[] = [];
          if (existsSync(eDir)) {
            for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
              if (result.length >= max) break;
              const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
              if (String(fields.section ?? "") === String(sectionId)) {
                result.push({
                  title: String(fields.title ?? f.replace(/\.md$/, "")),
                  summary: fields.summary ? String(fields.summary) : undefined,
                });
              }
            }
          }
          for (const child of sections.filter((s) => s.parent === sectionId)) {
            if (result.length >= max) break;
            result.push(...collectEntriesFromSection(child.id, max - result.length));
          }
          return result;
        };
        const childSecs = sec.childIds
          .map((cid) => sections.find((s) => s.id === cid))
          .filter(Boolean) as Section[];
        const totalWeight = childSecs.reduce((sum, c) => sum + Math.max(c.memberCount, 1), 0);
        const maxSamples = 10;
        for (const child of childSecs) {
          const quota = Math.max(1, Math.round((Math.max(child.memberCount, 1) / totalWeight) * maxSamples));
          memberInfo.push(...collectEntriesFromSection(child.id, quota));
        }
      }

      if (opts.dryRun && memberInfo.length > 0) {
        notify?.(`  would label: ${sec.id} (${memberInfo.length} members)`);
      } else if (memberInfo.length > 0 && sec.depth <= stConfig.llmNamingMaxDepth) {
        const ok = await llmLabelSection({
          engine, sec, memberInfo, sections, domain,
          withContext: true, touchUpdated: true, bubbleUp: false, notify,
        });
        if (ok) result.labelsUpdated++;
      } else if (memberInfo.length > 0) {
        const shortTitles = memberInfo.slice(0, 3).map((m) => {
          const t = m.title.split(":")[0].split("—")[0].split("–")[0].trim();
          return t.length > 40 ? t.slice(0, 37) + "..." : t;
        });
        sec.title = shortTitles.join(", ");
        sec.dirty = false;
        (sec as any).memberCountAtLastLabel = sec.memberCount;
        notify?.(`  auto-titled: ${sec.id} → "${sec.title}"`);
        result.labelsUpdated++;
      }
    }
  }
}

/**
 * Phase 3 — any leaf still over splitThreshold gets split again into a
 * 2-child grouping. The parent keeps its id but goes to 0 direct members.
 */
async function rebuildPostSplit(
  sections: Section[],
  ctx: RebuildCtx,
): Promise<void> {
  const { opts, domainsRoot, allVectors, result, allAssignments, stConfig } = ctx;
  const { engine, notify } = opts;
  for (const domain of result.domains) {
    const domCentroid = computeCentroid(allVectors.filter((v) => v.domain === domain).map((v) => v.vector));
    const eDir = join(domainsRoot, domain, "entries");
    let changed = true;
    while (changed) {
      changed = false;
      // Split any section whose DIRECT entries exceed splitThreshold — not
      // just leaves. A root that gained children via rebuildMergeSimilarRoots
      // still needs its own oversized direct-entry pile split; before this
      // filter was `childIds.length === 0`, which skipped exactly that case.
      for (const sec of [...sections].filter((s) => s.domain === domain && s.memberCount > stConfig.splitThreshold)) {
        const members: EntryWithVector[] = [];
        if (existsSync(eDir)) {
          for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
            const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
            if (String(fields.section ?? "") === String(sec.id)) {
              const v = allVectors.find((av) => av.entryId === f.replace(/\.md$/, ""));
              if (v) members.push({ entryId: v.entryId, sectionId: sec.id, vector: v.vector });
            }
          }
        }
        if (members.length <= stConfig.splitThreshold) continue;
        const sr = splitAsParentChild(sec, members, domCentroid, sections);
        if (!sr) continue;

        // Skip splits that would orphan a semantic outlier (e.g. 8+1). An
        // imbalanced split just wraps a well-formed section + a stray in a
        // fresh grouping node that the LLM can't name coherently. Leaving
        // the section slightly oversized is better than a lopsided wrapper.
        const minSide = Math.min(sr.parentMembers.length, sr.childMembers.length);
        if (minSide < stConfig.splitMinBalance) {
          notify?.(`  skip post-split: ${sec.id} (${members.length}) — imbalanced ${sr.parentMembers.length}+${sr.childMembers.length} < min ${stConfig.splitMinBalance}`);
          continue;
        }

        const childAId = mkSectionId(domain);
        const childBId = sr.childSection.id;
        notify?.(`  post-split: ${sec.id} (${members.length}) -> ${childAId}(${sr.parentMembers.length}) + ${childBId}(${sr.childMembers.length})`);

        const centroidA = computeCentroid(sr.parentMembers.map((m) => m.vector));
        sections.push(mkChildSection({
          id: childAId, domain,
          parent: sec.id, depth: sec.depth + 1,
          centroid: centroidA, memberCount: sr.parentMembers.length,
        }));

        // Child B was pre-built by splitAsParentChild; attach + mark dirty.
        sr.childSection.parent = sec.id;
        sr.childSection.depth = sec.depth + 1;
        sr.childSection.dirty = true;
        sections.push(sr.childSection);

        // Parent becomes a pure grouping node.
        sec.childIds.push(childAId, childBId);
        sec.memberCount = 0;
        sec.dirty = true;

        for (const m of sr.parentMembers) writeEntrySection(eDir, m.entryId, childAId, opts.dryRun);
        for (const [entryId, newSecId] of sr.reassignment) writeEntrySection(eDir, entryId, newSecId, opts.dryRun);
        result.splits++;
        changed = true;
      }
    }
  }
}

/**
 * Phase 4 — final sweep for singleton roots created by post-split. Looser
 * member count (direct + descendants) and looser neighbor filter than the
 * first absorb; both pre-existing differences preserved.
 */
/** Exported for tests. */
export function rebuildFinalAbsorb(
  sections: Section[],
  ctx: RebuildCtx,
): Section[] {
  const { opts, domainsRoot, allVectors, result, allAssignments, stConfig } = ctx;
  const { engine, notify } = opts;
  for (const domain of result.domains) {
    const domVecs = allVectors.filter((v) => v.domain === domain);
    const totalEntries = domVecs.length;
    const minEntries = Math.max(2, Math.ceil(totalEntries * stConfig.minRootRatio));
    const eDir = join(domainsRoot, domain, "entries");
    const domainRoots = sections.filter((s) => s.domain === domain && s.parent === null);
    // Entries in a section's whole subtree. Post-split can nest a root's
    // entries several levels down, leaving the root and its children with 0
    // direct members; counting one level made such a root look empty.
    const totalFor = (sec: Section): number =>
      sec.memberCount + sections.filter((s) => s.parent === sec.id).reduce((sum, c) => sum + totalFor(c), 0);
    for (const root of domainRoots) {
      const currentRoots = sections.filter((s) => s.domain === domain && s.parent === null);
      if (currentRoots.length <= 2) break;
      const actualMembers = totalFor(root);
      if (actualMembers >= minEntries) continue;
      if (root.childIds.length > 0 && actualMembers > 1) continue;
      const neighbors = domainRoots.filter((r) => r.id !== root.id);
      if (neighbors.length === 0) continue;
      let bestN = neighbors[0];
      let bestS = -1;
      for (const n of neighbors) {
        const sim = cosine(root.centroid, n.centroid);
        if (sim > bestS) { bestS = sim; bestN = n; }
      }
      notify?.(`  final absorb: "${root.title || root.id}" (${actualMembers}) -> "${bestN.title || bestN.id}"`);
      // The whole subtree goes: its few entries (actualMembers < minEntries)
      // move to bestN and every section under root is dropped, so nothing is
      // left pointing at a deleted parent.
      const descendantIds = new Set<string>();
      const addDesc = (pid: SectionId) => {
        descendantIds.add(String(pid));
        for (const s of sections) if (s.parent === pid) addDesc(s.id);
      };
      addDesc(root.id);
      if (existsSync(eDir)) {
        for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
          const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
          const cur = String(fields.section ?? "");
          if (descendantIds.has(cur)) {
            const eid = f.replace(/\.md$/, "");
            if (writeEntrySection(eDir, eid, bestN.id, opts.dryRun)) {
              bestN.memberCount++;
            }
          }
        }
      }
      sections = sections.filter((s) => !descendantIds.has(String(s.id)));
      result.merges++;
    }
  }
  return sections;
}

/**
 * Collapse root pairs with centroid cosine > rootMergeSimilarity. The smaller
 * root becomes a child of the larger one, preserving its subtree. Catches
 * semantically overlapping roots (e.g. "Pi-Durable Infrastructure" and
 * "Pi Durable Integration") that both exceed minRootRatio independently.
 *
 * Shared by rebuild + incremental. Both paths should produce the same tree
 * invariants after their structural work — that's how we avoid ever needing
 * a rebuild to recover shape quality.
 */
function mergeSimilarRoots(
  sections: Section[],
  allVectors: EntryVector[],
  domains: string[],
  result: ReorgResult,
  notify: ((m: string) => void) | undefined,
): Section[] {
  const stConfig = SECTION_TREE;

  // Count descendants (direct + all children's direct) once per section.
  function totalFor(sec: Section): number {
    let total = sec.memberCount;
    for (const c of sections.filter((s) => s.parent === sec.id)) total += totalFor(c);
    return total;
  }

  for (const domain of domains) {
    const domainEntries = allVectors.filter((v) => v.domain === domain).length;
    // Floor: don't collapse below the target root count. All wolfpack entries
    // are naturally similar; without a floor, every pair above threshold
    // chains into one mega-root.
    const targetRoots = Math.max(3, Math.round(Math.sqrt(domainEntries) * stConfig.rootCountFactor));

    let changed = true;
    while (changed) {
      changed = false;
      const roots = sections.filter((s) => s.domain === domain && s.parent === null);
      if (roots.length <= targetRoots) break;
      // Find the MOST similar pair across all pairs; merge only that one per
      // iteration so we don't chain-collapse through a weakly-similar bridge.
      let bestI = -1, bestJ = -1;
      let bestSim: number = stConfig.rootMergeSimilarity;
      for (let i = 0; i < roots.length; i++) {
        for (let j = i + 1; j < roots.length; j++) {
          const sim = cosine(roots[i].centroid, roots[j].centroid);
          if (sim > bestSim) { bestSim = sim; bestI = i; bestJ = j; }
        }
      }
      if (bestI < 0) break;
      const [larger, smaller] = totalFor(roots[bestI]) >= totalFor(roots[bestJ])
        ? [roots[bestI], roots[bestJ]]
        : [roots[bestJ], roots[bestI]];
      notify?.(`  merge root: "${smaller.title || smaller.id}" (${totalFor(smaller)}) → "${larger.title || larger.id}" (${totalFor(larger)}) [cos=${bestSim.toFixed(2)}]`);
      smaller.parent = larger.id;
      smaller.depth = larger.depth + 1;
      const bump = (parentId: SectionId, d: number): void => {
        for (const s of sections) {
          if (s.parent === parentId) {
            s.depth = d;
            bump(s.id, d + 1);
          }
        }
      };
      bump(smaller.id, smaller.depth + 1);
      if (!larger.childIds.includes(smaller.id)) larger.childIds.push(smaller.id);
      larger.dirty = true;
      result.merges++;
      changed = true;
    }
  }
  return sections;
}

/**
 * Collapse grouping wrappers whose entries are concentrated in a single
 * dominant child (>= dominantChildThreshold). The wrapper is removed and
 * all its children (dominant + minority) are promoted to the wrapper's
 * parent, becoming siblings there. Kills "wrapper named after its dominant
 * child" chains that add no navigational value.
 *
 * Shared by rebuild + incremental.
 */
function promoteDominantChildren(
  sections: Section[],
  domains: string[],
  domainsRoot: string,
  result: ReorgResult,
  notify: ((m: string) => void) | undefined,
  dryRun?: boolean,
): Section[] {
  const stConfig = SECTION_TREE;

  function totalFor(sec: Section): number {
    let total = sec.memberCount;
    for (const c of sections.filter((s) => s.parent === sec.id)) total += totalFor(c);
    return total;
  }

  for (const domain of domains) {
    const eDir = join(domainsRoot, domain, "entries");
    let changed = true;
    while (changed) {
      changed = false;
      // Walk deepest-first so promotions cascade correctly up the tree.
      const wrappers = sections
        .filter((s) => s.domain === domain && s.memberCount === 0)
        .sort((a, b) => b.depth - a.depth);
      for (const wrapper of wrappers) {
        const kids = sections.filter((s) => s.parent === wrapper.id);
        if (kids.length < 2) continue; // nothing to collapse
        const totals = kids.map((k) => ({ k, n: totalFor(k) }));
        const grand = totals.reduce((sum, t) => sum + t.n, 0);
        if (grand === 0) continue;
        const dominant = totals.find((t) => t.n / grand >= stConfig.dominantChildThreshold);
        if (!dominant) continue;

        notify?.(`  promote: wrapper "${wrapper.title || wrapper.id}" dominated by "${dominant.k.title || dominant.k.id}" (${dominant.n}/${grand}); promoting ${kids.length} children to parent`);

        // Safety check: in-memory memberCount==0 may be stale after upstream
        // mutations. Before deleting the wrapper, scan disk for any entries
        // whose frontmatter still points at it and reassign them to the
        // dominant child so we never orphan an entry via wrapper deletion.
        const strays = entriesPointingAt(eDir, wrapper.id);
        if (strays.length > 0) {
          notify?.(`    reassigning ${strays.length} stray entries from "${wrapper.id}" → "${dominant.k.id}"`);
          for (const eid of strays) writeEntrySection(eDir, eid, dominant.k.id, dryRun);
          dominant.k.memberCount += strays.length;
          dominant.k.dirty = true;
        }

        // Reparent every child of the wrapper to the wrapper's parent.
        for (const kid of kids) {
          kid.parent = wrapper.parent;
          kid.depth = wrapper.depth; // depth of wrapper's parent + 1 == wrapper's depth
          // Fix all its descendants' depths.
          const bump = (parentId: SectionId, d: number): void => {
            for (const s of sections) {
              if (s.parent === parentId) {
                s.depth = d;
                bump(s.id, d + 1);
              }
            }
          };
          bump(kid.id, kid.depth + 1);
        }
        // Rewire parent's childIds.
        if (wrapper.parent) {
          const parent = sections.find((s) => s.id === wrapper.parent);
          if (parent) {
            parent.childIds = parent.childIds.filter((c) => c !== wrapper.id);
            for (const kid of kids) {
              if (!parent.childIds.includes(kid.id)) parent.childIds.push(kid.id);
            }
            parent.dirty = true;
          }
        }
        sections = sections.filter((s) => s.id !== wrapper.id);
        result.merges++;
        changed = true;
        break; // re-sort after each change
      }
    }
  }
  return sections;
}

// ════════════════════════════════════════════════════════════════════════════
// Incremental per-domain
// ════════════════════════════════════════════════════════════════════════════

/**
 * Run the full incremental pipeline for one domain: split overflow, merge
 * underfull, place unplaced, prune empty, fix invariants, enforce branching
 * factor, detect drift, label dirty sections (with bubble-up).
 */
async function reorgDomain(
  domain: string,
  sections: Section[],
  ctx: IncrementalCtx,
): Promise<Section[]> {
  const { opts, domainsRoot, allVectors, result, events } = ctx;
  const { engine, notify } = opts;
notify?.(`reorg: ${domain}`);
const domainVectors = allVectors.filter((v) => v.domain === domain);
notify?.(`  ${domainVectors.length} entries with vectors`);
const eDir = join(domainsRoot, domain, "entries");

const entrySectionMap = new Map<string, string>();
if (existsSync(eDir)) {
  for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
    const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
    const eid = String(fields.id ?? f.replace(/\.md$/, ""));
    const sec = String(fields.section ?? "");
    if (sec) entrySectionMap.set(eid, sec);
  }
}

// Build section→members map. An entry whose section isn't in this domain's
// tree (another domain's section, or a deleted one) counts as unplaced, so the
// placement pass below re-homes it.
const domainSectionIds = new Set(sections.filter((s) => s.domain === domain).map((s) => s.id as string));
const sectionMembers = new Map<string, EntryWithVector[]>();
const unplaced: EntryWithVector[] = [];
for (const v of domainVectors) {
  const sec = entrySectionMap.get(v.entryId);
  if (sec && domainSectionIds.has(sec)) {
    if (!sectionMembers.has(sec)) sectionMembers.set(sec, []);
    sectionMembers.get(sec)!.push({
      entryId: v.entryId,
      sectionId: sec as SectionId,
      vector: v.vector,
    });
  } else {
    unplaced.push({ entryId: v.entryId, sectionId: "" as SectionId, vector: v.vector });
  }
}

// If targeted, only check touched sections
const domainSections = sections.filter((s) => s.domain === domain);
const sectionsToCheck = opts.touchedSections
  ? domainSections.filter((s) => opts.touchedSections!.has(s.id))
  : domainSections;

// 1. Split overflow sections (parent+child, not siblings)

const domainCentroid = domainVectors.length > 0
  ? computeCentroid(domainVectors.map((v) => v.vector))
  : [];
const stCfg = SECTION_TREE;
const toSplit = sectionsToCheck.filter(
  (s) => (sectionMembers.get(s.id)?.length ?? 0) > stCfg.splitThreshold,
);
for (const sec of toSplit) {
  const members = sectionMembers.get(sec.id) ?? [];
  const splitResult = splitAsParentChild(sec, members, domainCentroid, sections);
  if (!splitResult) {
    notify?.(`  skip split: ${sec.id} (no clean cut)`);
    continue;
  }
  // Same min-balance guard as the rebuild post-split: skip lopsided cuts
  // (e.g. 9+1) that just orphan a semantic outlier under a fresh wrapper.
  const minSide = Math.min(splitResult.parentMembers.length, splitResult.childMembers.length);
  if (minSide < stCfg.splitMinBalance) {
    notify?.(`  skip split: ${sec.id} (${members.length}) — imbalanced ${splitResult.parentMembers.length}+${splitResult.childMembers.length} < min ${stCfg.splitMinBalance}`);
    continue;
  }
  notify?.(`  split: ${sec.id} (${members.length} entries) → parent(${splitResult.parentMembers.length}) + child(${splitResult.childMembers.length})`);

  // Parent keeps its ID, child is new
  sec.childIds.push(splitResult.childSection.id);
  sec.memberCount = splitResult.parentMembers.length;
  sec.dirty = true;
  sections = [...sections, splitResult.childSection];
  result.splits++;

  events.push(ev.sectionCreated({
    sectionId: splitResult.childSection.id, domain, parent: sec.id, label: String(splitResult.childSection.label),
  }));

  // Update entry frontmatter for reassigned entries
  for (const [entryId, newSecId] of splitResult.reassignment) {
    writeEntrySection(eDir, entryId, newSecId, opts.dryRun);
    events.push(ev.entryPlaced({ entryId, sectionId: newSecId, basis: "routed", fit: 1 }));
    result.placements++;
  }

  // Update sectionMembers map
  sectionMembers.set(sec.id, splitResult.parentMembers.map((m) => ({ ...m, sectionId: sec.id })));
  sectionMembers.set(splitResult.childSection.id, splitResult.childMembers.map((m) => ({ ...m, sectionId: splitResult.childSection.id })));
}

// 2. Merge underfull sections
for (const sec of [...sections].filter((s) => s.domain === domain)) {
  const parentId = shouldMerge(sec);
  if (!parentId) continue;
  const parent = sections.find((s) => s.id === parentId);
  if (!parent) continue;
  const members = sectionMembers.get(sec.id) ?? [];
  notify?.(`  merge: ${sec.id} (${members.length} entries) → ${parentId}`);

  for (const m of members) {
    writeEntrySection(eDir, m.entryId, parentId, opts.dryRun);
    events.push(ev.entryPlaced({ entryId: m.entryId, sectionId: parentId, basis: "routed", fit: 1 }));
    result.placements++;
  }

  const parentMembers = sectionMembers.get(parentId) ?? [];
  sectionMembers.set(parentId, [...parentMembers, ...members.map((m) => ({ ...m, sectionId: parentId as SectionId }))]);
  sectionMembers.delete(sec.id);
  parent.memberCount += members.length;
  parent.childIds = parent.childIds.filter((c) => c !== sec.id);
  parent.dirty = true;
  sections = sections.filter((s) => s.id !== sec.id);
  result.merges++;
}

// 3. Place unplaced entries via placeEntry (replaces old crystallize)
if (!opts.touchedSections && unplaced.length > 0) {
  const placeEntryFn = placeEntry;
  notify?.(`  placing ${unplaced.length} unplaced entries`);
  for (const entry of unplaced) {
    // Read entry metadata for abstraction scoring
    const entryFile = join(eDir, `${entry.entryId}.md`);
    let meta: { kind?: string; maturity?: string } = {};
    if (existsSync(entryFile)) {
      const { fields } = parseFrontmatter(readFileSync(entryFile, "utf-8"));
      meta = { kind: fields.kind ? String(fields.kind) : undefined, maturity: fields.maturity ? String(fields.maturity) : undefined };
    }
    // Live filter: splits above may have added sections to this domain's tree.
    const decision = placeEntryFn(entry.vector, meta, sections.filter((s) => s.domain === domain), domainCentroid, sectionMembers);
    if (decision.sectionId !== "_unplaced") {
      const targetSec = sections.find((s) => s.id === decision.sectionId);
      if (targetSec) {
        writeEntrySection(eDir, entry.entryId, decision.sectionId, opts.dryRun);
        targetSec.memberCount++;
        const members = sectionMembers.get(decision.sectionId as string) ?? [];
        members.push(entry);
        sectionMembers.set(decision.sectionId as string, members);
        events.push(ev.entryPlaced({ entryId: entry.entryId, sectionId: decision.sectionId as SectionId, basis: "routed", fit: 1 }));
        result.placements++;
        notify?.(`  placed: ${entry.entryId} → ${decision.sectionId}`);
      }
    }
  }
}

// 4. Prune empty sections (0 entries, 0 children)
const beforePrune = sections.length;
sections = sections.filter((s) => {
  if (s.domain !== domain) return true;
  const members = sectionMembers.get(s.id) ?? [];
  const hasChildren = sections.some((c) => c.parent === s.id);
  if (members.length === 0 && !hasChildren) {
    notify?.(`  prune: ${s.id} "${s.title}" (empty)`);
    // Remove from parent's childIds
    if (s.parent) {
      const parent = sections.find((p) => p.id === s.parent);
      if (parent) parent.childIds = parent.childIds.filter((c) => c !== s.id);
    }
    result.merges++;
    return false;
  }
  return true;
});
if (beforePrune > sections.length) {
  notify?.(`  pruned ${beforePrune - sections.length} empty section(s)`);
}

// 5. Invariant checks

const totalDomainEntries = domainVectors.length;
const violations = checkInvariants(sections, domain, sectionMembers, totalDomainEntries);
for (const v of violations) {
  if (v.type === "weight_inversion") {
    // Swap parent and child
    const parent = sections.find((s) => s.id === v.section);
    const child = sections.find((s) => s.id === v.child);
    if (parent && child) {
      notify?.(`  fix inversion: ${parent.id} (${parent.memberCount}) <-> ${child.id} (${child.memberCount})`);
      // Swap parent relationship
      child.parent = parent.parent;
      child.depth = parent.depth;
      parent.parent = child.id;
      parent.depth = child.depth + 1;
      child.childIds = child.childIds.filter((c) => c !== parent.id);
      child.childIds.push(...parent.childIds.filter((c) => c !== child.id));
      parent.childIds = [child.id];
      // Actually this is complex — just mark dirty for now
      parent.dirty = true;
      child.dirty = true;
      result.merges++;
    }
  } else if (v.type === "singleton_root" && v.nearestNeighbor) {
    const sec = sections.find((s) => s.id === v.section);
    const neighbor = sections.find((s) => s.id === v.nearestNeighbor);
    if (sec && neighbor) {
      notify?.(`  absorb singleton: ${sec.id} "${sec.title}" → ${neighbor.id}`);
      // Move entries to neighbor
      const members = sectionMembers.get(sec.id as string) ?? [];
      for (const m of members) {
        writeEntrySection(eDir, m.entryId, neighbor.id, opts.dryRun);
        result.placements++;
      }
      // Transfer members
      const nMembers = sectionMembers.get(neighbor.id as string) ?? [];
      sectionMembers.set(neighbor.id as string, [...nMembers, ...members]);
      sectionMembers.delete(sec.id as string);
      neighbor.memberCount += members.length;
      neighbor.dirty = true;
      // Remove singleton
      sections = sections.filter((s) => s.id !== sec.id);
      result.merges++;
    }
  }
}

// 6. Branching factor control (maxChildrenPerSection)
const ST = SECTION_TREE;
for (const sec of sections.filter((s) => s.domain === domain)) {
  if (sec.childIds.length > ST.maxChildrenPerSection) {
    notify?.(`  group children: ${sec.id} has ${sec.childIds.length} children (max ${ST.maxChildrenPerSection})`);
    // Group via k-means on child centroids
    const childSecs = sec.childIds.map((cid) => sections.find((s) => s.id === cid)!).filter(Boolean);
    const k = Math.ceil(childSecs.length / ST.maxChildrenPerSection);
    if (k >= 2) {
      // Simple grouping: sort by centroid similarity and chunk
      const childVectors = childSecs.map((s) => s.centroid);
      const domCentroid = domainVectors.length > 0 ? computeCentroid(domainVectors.map((v) => v.vector)) : [];
      // Use cosine to domain centroid to sort, then chunk
      const sorted = childSecs
        .map((s) => ({ sec: s, sim: cosine(s.centroid, domCentroid) }))
        .sort((a, b) => b.sim - a.sim);
      const chunkSize = Math.ceil(sorted.length / k);
      const newChildIds: SectionId[] = [];
      for (let i = 0; i < sorted.length; i += chunkSize) {
        const chunk = sorted.slice(i, i + chunkSize);
        if (chunk.length === 1) {
          newChildIds.push(chunk[0].sec.id);
          continue;
        }
        const groupId = mkSectionId(domain);
        const groupCentroid = computeCentroid(chunk.map((c) => c.sec.centroid));
        for (const c of chunk) {
          c.sec.parent = groupId;
          c.sec.depth = sec.depth + 2;
        }
        sections.push(mkChildSection({
          id: groupId,
          domain,
          parent: sec.id,
          depth: sec.depth + 1,
          centroid: groupCentroid,
          memberCount: 0,
          childIds: chunk.map((c) => c.sec.id),
        }));
        newChildIds.push(groupId);
        result.splits++;
      }
      sec.childIds = newChildIds;
      sec.dirty = true;
    }
  }
}

// 7. Drift-based rename detection
const driftCfg = SECTION_TREE;
for (const sec of sections.filter((s) => s.domain === domain && !s.dirty)) {
  const lastCount = (sec as any).memberCountAtLastLabel ?? 0;
  const currentCount = sec.memberCount;
  if (lastCount > 0 && currentCount > 0) {
    const drift = Math.abs(currentCount - lastCount) / lastCount;
    if (drift >= driftCfg.driftRecalcThreshold) {
      notify?.(`  drift: ${sec.id} "${sec.title?.slice(0, 30)}" changed ${lastCount}→${currentCount} (${Math.round(drift * 100)}%)`);
      sec.dirty = true;
    }
  }
}

// 8. Label dirty sections (bottom-up, bubble to parents)
// If --resummarize-all, mark every section dirty first (used after a prompt
// or template change where every title/summary should be regenerated).
if (opts.resummarizeAll) {
  for (const sec of sections.filter((s) => s.domain === domain)) sec.dirty = true;
}
// Re-collect dirty each iteration since bubble-up marks new sections
let labelPass = 0;
while (true) {
  const dirty = sections
    .filter((s) => s.domain === domain && s.dirty)
    .sort((a, b) => b.depth - a.depth);
  if (dirty.length === 0 || labelPass > 5) break;
  labelPass++;
for (const sec of dirty) {
  const members = sectionMembers.get(sec.id) ?? [];
  const memberInfo: SectionMember[] = [];
  for (const m of members) {
    const file = join(eDir, `${m.entryId}.md`);
    if (existsSync(file)) {
      const { fields } = parseFrontmatter(readFileSync(file, "utf-8"));
      memberInfo.push({
        title: String(fields.title ?? m.entryId),
        summary: fields.summary ? String(fields.summary) : undefined,
      });
    }
  }
  // For parent sections with no direct members, collect descendant entry titles
  if (memberInfo.length === 0 && sec.childIds.length > 0) {
    function collectFromChildren(parentId: SectionId, max: number): SectionMember[] {
      const result: SectionMember[] = [];
      const childMembers = sectionMembers.get(parentId as string) ?? [];
      for (const m of childMembers) {
        if (result.length >= max) break;
        const file = join(eDir, `${m.entryId}.md`);
        if (existsSync(file)) {
          const { fields } = parseFrontmatter(readFileSync(file, "utf-8"));
          result.push({ title: String(fields.title ?? m.entryId), summary: fields.summary ? String(fields.summary) : undefined });
        }
      }
      for (const cid of sections.filter((s) => s.parent === parentId).map((s) => s.id)) {
        if (result.length >= max) break;
        result.push(...collectFromChildren(cid, max - result.length));
      }
      return result;
    }
    memberInfo.push(...collectFromChildren(sec.id, 8));
  }
  if (opts.dryRun && memberInfo.length > 0) {
    notify?.(`  would label: ${sec.id} (${memberInfo.length} members)`);
  } else if (memberInfo.length > 0) {
    const ok = await llmLabelSection({
      engine, sec, memberInfo, sections, domain,
      withContext: true, touchUpdated: true, bubbleUp: true, notify,
    });
    if (ok) result.labelsUpdated++;
  }
} // end while (label passes)

result.domains.push(domain);
  }

  return sections;
}
