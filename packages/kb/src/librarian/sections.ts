/**
 * sections.ts — Section tree registry (read/write/fold).
 *
 * Mirrors the ledger.ts + registry.ts pattern: events.jsonl is the source of
 * truth, _sections.json is a derived snapshot for fast reads, and the tree
 * is folded on each sweep.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { atomicWrite } from "@wolfpack/engine";
import type { KbRoots, KbEvent } from "../shared/index.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";
import { now } from "../shared/ids.js";

// ── paths ────────────────────────────────────────────────────────────────────

export const sectionsFile = (r: KbRoots) =>
  join(r.denLocal, "sections", "_sections.json");

// ── persistence ──────────────────────────────────────────────────────────────

/** Read the current section tree snapshot. */
export function readSections(roots: KbRoots): Section[] {
  const file = sectionsFile(roots);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return [];
  }
}

/** Write the section tree snapshot (atomic). */
export function writeSections(roots: KbRoots, sections: Section[]): void {
  const file = sectionsFile(roots);
  mkdirSync(dirname(file), { recursive: true });
  atomicWrite(file, JSON.stringify(sections, null, 2));
}

// ── projection (pure) ────────────────────────────────────────────────────────

/**
 * Fold section events into a section tree. This mirrors foldRegistry from
 * ledger.ts — events are the truth, the tree is derived.
 */
export function foldSections(events: KbEvent[]): Section[] {
  const sections = new Map<string, Section>();

  for (const e of events) {
    switch (e.t) {
      case "section_created": {
        if (!sections.has(e.sectionId)) {
          // Create a minimal section; centroid + summary will be computed later
          sections.set(e.sectionId, {
            id: e.sectionId as SectionId,
            domain: e.domain as DomainId,
            parent: e.parent as SectionId | null,
            depth: e.parent ? (sections.get(e.parent)?.depth ?? 0) + 1 : 0,
            label: e.label as any,
            title: e.label,
            centroid: new Array(768).fill(0),
            memberCount: 0,
            childIds: [],
            summary: "",
            summaryHash: "",
            dirty: true,
            created: e.at as any,
            updated: e.at as any,
          });
          // Add to parent's childIds if parent exists
          if (e.parent && sections.has(e.parent)) {
            const parent = sections.get(e.parent)!;
            if (!parent.childIds.includes(e.sectionId as SectionId)) {
              parent.childIds.push(e.sectionId as SectionId);
            }
          }
        }
        break;
      }
      case "section_split": {
        const section = sections.get(e.sectionId);
        if (section) {
          section.childIds = e.childIds as SectionId[];
          section.updated = e.at as any;
          section.dirty = true;
        }
        break;
      }
      case "entry_placed": {
        const section = sections.get(e.sectionId);
        if (section) {
          section.memberCount++;
          section.updated = e.at as any;
          section.dirty = true;
        }
        break;
      }
      case "crystallized_v2": {
        const section = sections.get(e.sectionId);
        if (section) {
          section.memberCount = e.entryIds.length;
          section.updated = e.at as any;
          section.dirty = true;
        }
        break;
      }
    }
  }

  return Array.from(sections.values());
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Find a section by id. */
export function findSection(sections: Section[], id: SectionId): Section | null {
  return sections.find((s) => s.id === id) ?? null;
}

/** Get all child sections of a parent. */
export function getChildren(sections: Section[], parentId: SectionId): Section[] {
  return sections.filter((s) => s.parent === parentId);
}

/** Get root sections (parent === null) for a domain. */
export function getRoots(sections: Section[], domain: DomainId): Section[] {
  return sections.filter((s) => s.parent === null && s.domain === domain);
}

/** Build a parent-to-children index for fast lookups. */
export function buildParentIndex(
  sections: Section[]
): Map<SectionId | null, Section[]> {
  const index = new Map<SectionId | null, Section[]>();
  for (const s of sections) {
    const key = s.parent;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(s);
  }
  return index;
}
