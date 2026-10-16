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
  let content = readFileSync(file, "utf-8");
  content = content.replace(/^section: .+$/m, `section: ${sectionId}`);
  writeFileSync(file, content);
  return true;
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
function persistDomains(
  roots: KbRoots,
  sections: Section[],
  domains: string[],
  dryRun?: boolean,
): void {
  if (dryRun) return;
  writeSections(roots, sections);
  for (const domain of domains) {
    renderDomainDigest(roots, domain);
    renderDomainIndex(roots, domain);
  }
}

/**
 * Collapse any root (parent === null) that has 0 direct entries by promoting
 * its children to root level. Runs iteratively until the tree stabilizes.
 */
function collapseEmptyRootWrappers(
  sections: Section[],
  domain: string,
  eDir: string,
  notify?: (msg: string) => void,
): Section[] {
  let out = sections;
  let collapsed = true;
  while (collapsed) {
    collapsed = false;
    const domainRoots = out.filter(
      (s) => s.parent === null && String(s.domain) === domain,
    );
    for (const root of domainRoots) {
      if (sectionHasEntriesOnDisk(eDir, root.id)) continue;
      if (root.childIds.length === 0) continue;
      for (const cid of root.childIds) {
        const child = out.find((s) => s.id === cid);
        if (!child) continue;
        child.parent = null;
        child.depth = 0;
        const fixDepth = (parentId: SectionId, d: number): void => {
          for (const s of out) {
            if (s.parent === parentId) {
              s.depth = d;
              fixDepth(s.id, d + 1);
            }
          }
        };
        fixDepth(child.id, 1);
      }
      out = out.filter((s) => s.id !== root.id);
      notify?.(`  collapse: removed empty root wrapper "${root.title}" for ${domain}`);
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
    } = {
      sampleTitles: memberInfo.map((m) => m.title),
      depth: sec.depth,
      maxDepth: maxTreeDepth,
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
 * Collapse any section (at any depth) with 0 direct entries and exactly 2
 * actual children (binary-split artifact). Promotes the children to the
 * wrapper's parent. Uses actual parent relationships rather than
 * `childIds` which can be stale.
 */
function collapseBinaryWrappers(
  sections: Section[],
  domain: string,
  eDir: string,
  notify?: (msg: string) => void,
): Section[] {
  let out = sections;
  let collapsed = true;
  while (collapsed) {
    collapsed = false;
    for (const sec of [...out]) {
      if (String(sec.domain) !== domain) continue;
      const actualChildren = out.filter((s) => s.parent === sec.id);
      if (actualChildren.length !== 2) continue;
      if (sectionHasEntriesOnDisk(eDir, sec.id)) continue;
      for (const child of actualChildren) {
        child.parent = sec.parent;
        child.depth = sec.depth;
        if (sec.parent) {
          const parent = out.find((s) => s.id === sec.parent);
          if (parent && !parent.childIds.includes(child.id)) {
            parent.childIds.push(child.id);
          }
        }
      }
      if (sec.parent) {
        const parent = out.find((s) => s.id === sec.parent);
        if (parent) parent.childIds = parent.childIds.filter((c) => c !== sec.id);
      }
      out = out.filter((s) => s.id !== sec.id);
      notify?.(`  collapse: removed binary wrapper "${sec.title || sec.id}" at depth ${sec.depth}`);
      collapsed = true;
      break;
    }
  }
  return out;
}

export async function reorg(opts: ReorgOptions): Promise<ReorgResult> {
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

    for (const domain of domains) {
      sections = await rebuildBootstrapDomain(domain, sections, rctx);
    }
    sections = rebuildAbsorbSingletonRoots(sections, rctx);
    await rebuildLabelAfter(sections, rctx);
    for (const d of result.domains) reconcileMemberCounts(sections, d, join(domainsRoot, d, "entries"));
    await rebuildPostSplit(sections, rctx);
    await rebuildLabelPostSplit(sections, rctx);
    sections = rebuildFinalAbsorb(sections, rctx);
    for (const d of result.domains) reconcileMemberCounts(sections, d, join(domainsRoot, d, "entries"));

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

  // Collapse empty root wrappers + binary-split artifacts at all depths.
  for (const domain of result.domains) {
    const eDir = join(domainsRoot, domain, "entries");
    sections = collapseEmptyRootWrappers(sections, domain, eDir, notify);
    sections = collapseBinaryWrappers(sections, domain, eDir, notify);
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

      sections = sections.filter((s) => s.id !== root.id);
      result.merges++;
    }
  }
  return sections;
}

/** Phase 3 — label every dirty section bottom-up. */
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
 * Phase 4 — any leaf still over splitThreshold gets split again into a
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
      for (const sec of [...sections].filter((s) => s.domain === domain && s.childIds.length === 0 && s.memberCount > 8)) {
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
        if (members.length <= 8) continue;
        const sr = splitAsParentChild(sec, members, domCentroid, sections);
        if (!sr) continue;

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

/** Phase 5 — label the two children emitted by post-split. */
async function rebuildLabelPostSplit(
  sections: Section[],
  ctx: RebuildCtx,
): Promise<void> {
  const { opts, domainsRoot, allVectors, result, allAssignments, stConfig } = ctx;
  const { engine, notify } = opts;
  for (const domain of result.domains) {
    const eDir = join(domainsRoot, domain, "entries");
    const postSplitDirty = sections.filter(
      (s) => s.domain === domain && s.dirty && (!s.title || s.title.includes("(split)")),
    );
    for (const sec of postSplitDirty) {
      const memberInfo: SectionMember[] = readDirectMembersFromDisk(eDir, sec.id);
      if (memberInfo.length === 0) {
        for (const cid of sec.childIds) {
          const child = sections.find((s) => s.id === cid);
          if (child && child.title) memberInfo.push({ title: child.title, summary: child.summary });
        }
      }
      if (opts.dryRun && memberInfo.length > 0) {
        notify?.(`  would post-split label: ${sec.id}`);
      } else if (memberInfo.length > 0) {
        const ok = await llmLabelSection({
          engine, sec, memberInfo, sections, domain,
          withContext: false, touchUpdated: false, bubbleUp: false,
          logPrefix: "post-split labeled", notify,
        });
        if (ok) result.labelsUpdated++;
      }
    }
  }
}

/**
 * Phase 6 — final sweep for singleton roots created by post-split. Looser
 * member count (direct + descendants) and looser neighbor filter than the
 * first absorb; both pre-existing differences preserved.
 */
function rebuildFinalAbsorb(
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
    for (const root of domainRoots) {
      const currentRoots = sections.filter((s) => s.domain === domain && s.parent === null);
      if (currentRoots.length <= 2) break;
      const actualMembers =
        root.memberCount +
        sections.filter((s) => s.parent === root.id).reduce((sum, c) => sum + c.memberCount, 0);
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
      notify?.(`  final absorb: "${root.title}" (${actualMembers}) -> "${bestN.title}"`);
      if (existsSync(eDir)) {
        for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
          const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
          if (String(fields.section ?? "") === String(root.id)) {
            const eid = f.replace(/\.md$/, "");
            if (writeEntrySection(eDir, eid, bestN.id, opts.dryRun)) {
              bestN.memberCount++;
            }
          }
        }
      }
      sections = sections.filter((s) => s.id !== root.id);
      result.merges++;
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

// Build section→members map
const sectionMembers = new Map<string, EntryWithVector[]>();
const unplaced: EntryWithVector[] = [];
for (const v of domainVectors) {
  const sec = entrySectionMap.get(v.entryId);
  if (sec) {
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
const toSplit = sectionsToCheck.filter(
  (s) => (sectionMembers.get(s.id)?.length ?? 0) > 8
);
for (const sec of toSplit) {
  const members = sectionMembers.get(sec.id) ?? [];
  const splitResult = splitAsParentChild(sec, members, domainCentroid, sections);
  if (!splitResult) {
    notify?.(`  skip split: ${sec.id} (no clean cut)`);
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
    const decision = placeEntryFn(entry.vector, meta, sections, domainCentroid, sectionMembers);
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
