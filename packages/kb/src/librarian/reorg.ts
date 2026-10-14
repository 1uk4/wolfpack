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
  maybeSplit,
  shouldMerge,
  crystallizeUnplaced,
  type EntryWithVector,
} from "./hierarchy.js";
import { labelSection, sectionSummary, type SectionMember } from "./summarize.js";
import { createEmbedder, buildEntryVectors, cosine } from "./embed.js";
import { computeCentroid } from "./hierarchy.js";
import { ev, type KbEvent } from "../shared/index.js";

export interface ReorgOptions {
  engine: Engine;
  roots: KbRoots;
  /** Only reorg these domains (default: all) */
  domains?: string[];
  /** Only check these sections (for post-sweep targeted reorg) */
  touchedSections?: Set<string>;
  /** Full bottom-up rebuild of the section tree (agglomerative clustering) */
  rebuild?: boolean;
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
          dirty: true,
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
    const { buildTreeBottomUp } = await import("./section-tree.js");
    const allAssignments = new Map<string, Map<string, SectionId>>();
    
    for (const domain of domains) {
      const domainVectors = allVectors.filter((v) => v.domain === domain);
      if (domainVectors.length === 0) {
        notify?.(`rebuild: ${domain} — no entries, skipping`);
        continue;
      }
      
      notify?.(`rebuild: ${domain} (${domainVectors.length} entries)`);
      
      // Compute domain centroid
      const domainCentroid = computeCentroid(domainVectors.map((v) => v.vector));
      
      // Build entries with vectors for the algorithm
      const entries: EntryWithVector[] = domainVectors.map((v) => ({
        entryId: v.entryId,
        sectionId: "" as SectionId,
        vector: v.vector,
      }));
      
      // Build the tree (returns sections + entry→section assignments)
      const treeResult = buildTreeBottomUp(entries, domain, domainCentroid);
      notify?.(`  built ${treeResult.sections.length} sections`);
      
      // Remove old sections for this domain
      sections = sections.filter((s) => s.domain !== domain);
      sections.push(...treeResult.sections);
      
      // Assign entries using the tree's built-in assignments
      const eDir = join(domainsRoot, domain, "entries");
      let placed = 0;
      for (const [entryId, sectionId] of treeResult.assignments) {
        const file = join(eDir, `${entryId}.md`);
        if (existsSync(file)) {
          let content = readFileSync(file, "utf-8");
          content = content.replace(/^section: .+$/m, `section: ${sectionId}`);
          writeFileSync(file, content);
          placed++;
        }
      }
      notify?.(`  placed ${placed} entries into leaf sections`);
      
      // Mark all sections as dirty for LLM naming
      for (const sec of treeResult.sections) {
        sec.dirty = true;
      }
      
      result.placements += placed;
      result.rebuilt = true;
      result.domains.push(domain);
      allAssignments.set(domain, treeResult.assignments);
    }
    
    // Absorb singleton roots into nearest neighbor
    const { SECTION_TREE: stConfig } = await import("@wolfpack/engine");
    for (const domain of result.domains) {
      const domVecs = allVectors.filter((v) => v.domain === domain);
      const totalEntries = domVecs.length;
      const minEntries = Math.max(2, Math.ceil(totalEntries * stConfig.minRootRatio));
      const domainRoots = sections.filter((s) => s.domain === domain && s.parent === null);
      const eDir = join(domainsRoot, domain, "entries");
      
      for (const root of domainRoots) {
        if (root.memberCount >= minEntries) continue;
        if (root.childIds.length > 0) continue; // has children, not a singleton
        
        // Find nearest non-singleton root by centroid similarity
        const neighbors = domainRoots.filter((r) => r.id !== root.id && (r.memberCount >= minEntries || r.childIds.length > 0));
        if (neighbors.length === 0) continue;
        
        let bestNeighbor = neighbors[0];
        let bestSim = -1;
        for (const n of neighbors) {
          const sim = cosine(root.centroid, n.centroid);
          if (sim > bestSim) { bestSim = sim; bestNeighbor = n; }
        }
        
        notify?.(`  absorb: "${root.title || root.id}" (${root.memberCount}) → "${bestNeighbor.title || bestNeighbor.id}"`);
        
        // Move this root's entries to the neighbor
        const domAssignments = allAssignments.get(domain) ?? new Map();
        for (const [entryId, secId] of domAssignments) {
          if (secId === root.id) {
            // Find the best leaf section under the neighbor
            const neighborLeaves = sections.filter((s) => {
              let cur = s;
              while (cur.parent) {
                if (cur.parent === bestNeighbor.id) return true;
                cur = sections.find((p) => p.id === cur.parent)!;
                if (!cur) break;
              }
              return s.id === bestNeighbor.id;
            }).filter((s) => s.childIds.length === 0);
            
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
            const file = join(eDir, `${entryId}.md`);
            if (existsSync(file)) {
              let content = readFileSync(file, "utf-8");
              content = content.replace(/^section: .+$/m, `section: ${targetSec}`);
              writeFileSync(file, content);
            }
          }
        }
        
        // Remove the singleton root
        sections = sections.filter((s) => s.id !== root.id);
        result.merges++;
      }
    }
    
    // Label dirty sections via LLM
    for (const domain of result.domains) {
      const eDir = join(domainsRoot, domain, "entries");
      // Label bottom-up: deepest first so children have titles before parents
      const dirtySections = sections
        .filter((s) => s.domain === domain && s.dirty)
        .sort((a, b) => b.depth - a.depth);
      notify?.(`  labeling ${dirtySections.length} sections (depth ${Math.max(...dirtySections.map(s => s.depth))} → 0)...`);
      
      for (const sec of dirtySections) {
        // Get member info (direct members or children's titles for parents)
        const memberInfo: SectionMember[] = [];
        
        // Direct members
        if (existsSync(eDir)) {
          for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
            const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
            if (String(fields.section ?? "") === sec.id) {
              memberInfo.push({
                title: String(fields.title ?? f.replace(/\.md$/, "")),
                summary: fields.summary ? String(fields.summary) : undefined,
              });
            }
          }
        }
        
        // For parents with 0 direct members, collect entry titles from descendants
        // Weight proportionally by child size so all branches contribute
        if (memberInfo.length === 0 && sec.childIds.length > 0) {
          function collectEntriesFromSection(sectionId: SectionId, max: number): SectionMember[] {
            const result: SectionMember[] = [];
            if (existsSync(eDir)) {
              for (const f of readdirSync(eDir).filter((x) => x.endsWith(".md"))) {
                if (result.length >= max) break;
                const { fields } = parseFrontmatter(readFileSync(join(eDir, f), "utf-8"));
                if (String(fields.section ?? "") === String(sectionId)) {
                  result.push({ title: String(fields.title ?? f.replace(/\.md$/, "")), summary: fields.summary ? String(fields.summary) : undefined });
                }
              }
            }
            for (const child of sections.filter((s) => s.parent === sectionId)) {
              if (result.length >= max) break;
              result.push(...collectEntriesFromSection(child.id, max - result.length));
            }
            return result;
          }
          
          // Weighted sampling: each child contributes proportional to its total entries
          const childSecs = sec.childIds.map((cid) => sections.find((s) => s.id === cid)).filter(Boolean) as Section[];
          const totalWeight = childSecs.reduce((sum, c) => sum + Math.max(c.memberCount, 1), 0);
          const maxSamples = 10;
          for (const child of childSecs) {
            const quota = Math.max(1, Math.round((Math.max(child.memberCount, 1) / totalWeight) * maxSamples));
            memberInfo.push(...collectEntriesFromSection(child.id, quota));
          }
        }
        
        const { SECTION_TREE: stCfg } = await import("@wolfpack/engine");
        if (memberInfo.length > 0 && sec.depth <= stCfg.llmNamingMaxDepth) {
          try {
            const maxTreeDepth = Math.max(...sections.filter(s => s.domain === domain).map(s => s.depth), 0);
            sec.summary = await sectionSummary(engine, memberInfo, { depth: sec.depth, maxDepth: maxTreeDepth });
            const parent = sec.parent ? sections.find((s) => s.id === sec.parent) : null;
            const siblings = sections
              .filter((s) => s.parent === sec.parent && s.id !== sec.id && s.domain === domain)
              .map((s) => s.summary);
            sec.title = await labelSection(engine, sec.summary, {
              sampleTitles: memberInfo.map((m) => m.title),
              parentTitle: parent?.title,
              siblingSummaries: siblings,
              depth: sec.depth,
              maxDepth: maxTreeDepth,
            });
            sec.dirty = false;
            sec.updated = new Date().toISOString().split("T")[0] as any;
            notify?.(`  labeled: ${sec.id} → "${sec.title}"`);
            result.labelsUpdated++;
          } catch (e) {
            notify?.(`  label failed: ${sec.id}: ${e}`);
          }
        } else if (memberInfo.length > 0) {
          // Auto-title: short summary from first 3 member titles
          const shortTitles = memberInfo.slice(0, 3).map((m) => {
            const t = m.title.split(":")[0].split("—")[0].split("–")[0].trim();
            return t.length > 40 ? t.slice(0, 37) + "..." : t;
          });
          sec.title = shortTitles.join(", ");
          sec.dirty = false;
          notify?.(`  auto-titled: ${sec.id} → "${sec.title}"`);
          result.labelsUpdated++;
        }
      }
    }
    
    // Persist
    writeSections(roots, sections);
    const freshLog = readLedger(roots);
    renderRegistry(roots, foldRegistry(freshLog));
    for (const domain of result.domains) {
      renderDomainDigest(roots, domain);
      renderDomainIndex(roots, domain);
    }
    
    notify?.(`rebuild done: ${result.placements} entries placed, ${result.labelsUpdated} sections labeled`);
    return result;
  }

  for (const domain of domains) {
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
    const { splitAsParentChild } = await import("./section-tree.js");
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
        const file = join(eDir, `${entryId}.md`);
        if (existsSync(file)) {
          let content = readFileSync(file, "utf-8");
          content = content.replace(/^section: .+$/m, `section: ${newSecId}`);
          writeFileSync(file, content);
        }
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
        const file = join(eDir, `${m.entryId}.md`);
        if (existsSync(file)) {
          let content = readFileSync(file, "utf-8");
          content = content.replace(/^section: .+$/m, `section: ${parentId}`);
          writeFileSync(file, content);
        }
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

    // 3. Crystallize unplaced (only on full reorg, not targeted)
    if (!opts.touchedSections && unplaced.length > 0) {
      const domSections = sections.filter((s) => s.domain === domain);
      const candidates = crystallizeUnplaced(unplaced, domSections, domain as DomainId);
      for (const c of candidates) {
        notify?.(`  crystallize: ${c.section.id} (${c.entryIds.length} entries)`);
        sections = [...sections, c.section];
        events.push(ev.sectionCreated({
          sectionId: c.section.id, domain, parent: c.section.parent, label: String(c.section.label),
        }));
        events.push(ev.sectionCrystallized({
          sectionId: c.section.id, parentId: c.section.parent ?? "", entryIds: c.entryIds, cohesion: c.cohesion,
        }));
        for (const eid of c.entryIds) {
          const file = join(eDir, `${eid}.md`);
          if (existsSync(file)) {
            let content = readFileSync(file, "utf-8");
            content = content.replace(/^section: .+$/m, `section: ${c.section.id}`);
            writeFileSync(file, content);
          }
          events.push(ev.entryPlaced({ entryId: eid, sectionId: c.section.id, basis: "crystallized", fit: 1 }));
          result.placements++;
        }
        result.crystallized++;
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
    const { checkInvariants } = await import("./section-tree.js");
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
            const file = join(eDir, `${m.entryId}.md`);
            if (existsSync(file)) {
              let content = readFileSync(file, "utf-8");
              content = content.replace(/^section: .+$/m, `section: ${neighbor.id}`);
              writeFileSync(file, content);
            }
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
    const { SECTION_TREE: ST } = await import("@wolfpack/engine");
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
            sections.push({
              id: groupId,
              domain: domain as DomainId,
              parent: sec.id,
              depth: sec.depth + 1,
              label: groupId.slice(-7) as any,
              title: "",
              centroid: groupCentroid,
              memberCount: 0,
              childIds: chunk.map((c) => c.sec.id),
              summary: "",
              summaryHash: "",
              dirty: true,
              created: new Date().toISOString().split("T")[0] as any,
              updated: new Date().toISOString().split("T")[0] as any,
            } as Section);
            newChildIds.push(groupId);
            result.splits++;
          }
          sec.childIds = newChildIds;
          sec.dirty = true;
        }
      }
    }

    // 7. Label dirty sections
    const dirty = sections.filter((s) => s.domain === domain && s.dirty);
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
      if (memberInfo.length > 0) {
        try {
          const maxTreeDepth = Math.max(...sections.filter(s => s.domain === domain).map(s => s.depth), 0);
          sec.summary = await sectionSummary(engine, memberInfo, { depth: sec.depth, maxDepth: maxTreeDepth });
          const parent = sec.parent ? sections.find((s) => s.id === sec.parent) : null;
          const siblings = sections
            .filter((s) => s.parent === sec.parent && s.id !== sec.id && s.domain === domain)
            .map((s) => s.summary);
          sec.title = await labelSection(engine, sec.summary, {
            sampleTitles: memberInfo.map((m) => m.title),
            parentTitle: parent?.title,
            siblingSummaries: siblings,
            depth: sec.depth,
            maxDepth: maxTreeDepth,
          });
          sec.dirty = false;
          sec.updated = new Date().toISOString().split("T")[0] as any;
          notify?.(`  labeled: ${sec.id} → "${sec.title}"`);
          result.labelsUpdated++;
        } catch (e) {
          notify?.(`  label failed: ${sec.id}: ${e}`);
        }
      }
    }

    result.domains.push(domain);
  }

  // Persist
  if (events.length > 0) {
    appendLedger(roots, events);
  }
  writeSections(roots, sections);

  // Re-render digest + index
  const freshLog = readLedger(roots);
  renderRegistry(roots, foldRegistry(freshLog));
  for (const domain of result.domains) {
    renderDomainDigest(roots, domain);
    renderDomainIndex(roots, domain);
  }

  notify?.(`reorg done: ${result.splits} splits, ${result.merges} merges, ${result.crystallized} crystallized, ${result.labelsUpdated} labeled`);
  return result;
}
