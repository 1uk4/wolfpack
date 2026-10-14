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
import { createEmbedder, buildEntryVectors } from "./embed.js";
import { ev, type KbEvent } from "../shared/index.js";

export interface ReorgOptions {
  engine: Engine;
  roots: KbRoots;
  /** Only reorg these domains (default: all) */
  domains?: string[];
  /** Only check these sections (for post-sweep targeted reorg) */
  touchedSections?: Set<string>;
  notify?: (msg: string) => void;
}

export interface ReorgResult {
  splits: number;
  merges: number;
  crystallized: number;
  placements: number;
  labelsUpdated: number;
  domains: string[];
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

    // 1. Split overflow sections
    const toSplit = sectionsToCheck.filter(
      (s) => (sectionMembers.get(s.id)?.length ?? 0) > 8
    );
    for (const sec of toSplit) {
      const members = sectionMembers.get(sec.id) ?? [];
      const splitResult = maybeSplit(sec, members);
      if (!splitResult) {
        notify?.(`  skip split: ${sec.id} (no clean cut)`);
        continue;
      }
      notify?.(`  split: ${sec.id} (${members.length} entries) → ${splitResult.children.length} children`);

      sec.childIds.push(...splitResult.children.map((c) => c.id));
      sec.dirty = true;
      sections = [...sections, ...splitResult.children];
      result.splits++;

      events.push(ev.sectionSplit(sec.id, sec.parent ?? "", splitResult.children.map((c) => c.id)));
      for (const child of splitResult.children) {
        events.push(ev.sectionCreated({
          sectionId: child.id, domain, parent: sec.id, label: String(child.label),
        }));
      }

      for (const [entryId, newSecId] of splitResult.reassignment) {
        const file = join(eDir, `${entryId}.md`);
        if (existsSync(file)) {
          let content = readFileSync(file, "utf-8");
          content = content.replace(/^section: .+$/m, `section: ${newSecId}`);
          content = content.replace(/^(placement:)\n(  basis: ).+$/m, `$1\n$2routed`);
          writeFileSync(file, content);
        }
        events.push(ev.entryPlaced({ entryId, sectionId: newSecId, basis: "routed", fit: 1 }));
        result.placements++;
      }

      sectionMembers.delete(sec.id);
      for (const child of splitResult.children) {
        const childMembers = members.filter((m) => splitResult.reassignment.get(m.entryId) === child.id);
        sectionMembers.set(child.id, childMembers.map((m) => ({ ...m, sectionId: child.id })));
      }
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

    // 4. Label dirty sections
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
      // For parent sections with no direct members, use children's titles
      if (memberInfo.length === 0 && sec.childIds.length > 0) {
        const childSections = sections.filter((s) => sec.childIds.includes(s.id));
        for (const child of childSections) {
          memberInfo.push({ title: child.title, summary: child.summary });
        }
      }
      if (memberInfo.length > 0) {
        try {
          sec.summary = await sectionSummary(engine, memberInfo);
          const parent = sec.parent ? sections.find((s) => s.id === sec.parent) : null;
          const siblings = sections
            .filter((s) => s.parent === sec.parent && s.id !== sec.id && s.domain === domain)
            .map((s) => s.summary);
          sec.title = await labelSection(engine, sec.summary, {
            sampleTitles: memberInfo.map((m) => m.title),
            parentTitle: parent?.title,
            siblingSummaries: siblings,
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
