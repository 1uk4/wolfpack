/**
 * sections.test.ts — Tests for section tree registry.
 */
import { describe, it, expect } from "vitest";
import {
  foldSections,
  findSection,
  getChildren,
  getRoots,
  buildParentIndex,
} from "./sections.js";
import type { KbEvent } from "../shared/index.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";

describe("sections — fold events into tree", () => {
  it("creates section from section_created event", () => {
    const events: KbEvent[] = [
      {
        id: "evt-001",
        at: "2024-01-01T00:00:00.000Z",
        t: "section_created",
        sectionId: "sec-wp-000001",
        domain: "wolfpack",
        parent: null,
        label: "root",
      },
    ];

    const sections = foldSections(events);
    expect(sections.length).toBe(1);
    expect(sections[0].id).toBe("sec-wp-000001" as SectionId);
    expect(sections[0].domain).toBe("wolfpack" as DomainId);
    expect(sections[0].parent).toBeNull();
  });

  it("builds parent-child relationships", () => {
    const events: KbEvent[] = [
      {
        id: "evt-001",
        at: "2024-01-01T00:00:00.000Z",
        t: "section_created",
        sectionId: "sec-wp-000001",
        domain: "wolfpack",
        parent: null,
        label: "root",
      },
      {
        id: "evt-002",
        at: "2024-01-01T00:01:00.000Z",
        t: "section_created",
        sectionId: "sec-wp-000002",
        domain: "wolfpack",
        parent: "sec-wp-000001",
        label: "child1",
      },
      {
        id: "evt-003",
        at: "2024-01-01T00:02:00.000Z",
        t: "section_created",
        sectionId: "sec-wp-000003",
        domain: "wolfpack",
        parent: "sec-wp-000001",
        label: "child2",
      },
    ];

    const sections = foldSections(events);
    expect(sections.length).toBe(3);

    const root = sections.find((s) => s.id === "sec-wp-000001");
    expect(root).toBeDefined();
    expect(root!.childIds).toContain("sec-wp-000002" as SectionId);
    expect(root!.childIds).toContain("sec-wp-000003" as SectionId);

    const child1 = sections.find((s) => s.id === "sec-wp-000002");
    expect(child1!.parent).toBe("sec-wp-000001" as SectionId);
  });

  it("tracks member count from entry_placed events", () => {
    const events: KbEvent[] = [
      {
        id: "evt-001",
        at: "2024-01-01T00:00:00.000Z",
        t: "section_created",
        sectionId: "sec-wp-000001",
        domain: "wolfpack",
        parent: null,
        label: "root",
      },
      {
        id: "evt-002",
        at: "2024-01-01T00:01:00.000Z",
        t: "entry_placed",
        entryId: "kb-wolfpack-abc1234",
        sectionId: "sec-wp-000001",
        basis: "routed",
        fit: 0.85,
      },
      {
        id: "evt-003",
        at: "2024-01-01T00:02:00.000Z",
        t: "entry_placed",
        entryId: "kb-wolfpack-def5678",
        sectionId: "sec-wp-000001",
        basis: "routed",
        fit: 0.90,
      },
    ];

    const sections = foldSections(events);
    const section = sections.find((s) => s.id === "sec-wp-000001");
    expect(section!.memberCount).toBe(2);
  });

  it("marks sections dirty on updates", () => {
    const events: KbEvent[] = [
      {
        id: "evt-001",
        at: "2024-01-01T00:00:00.000Z",
        t: "section_created",
        sectionId: "sec-wp-000001",
        domain: "wolfpack",
        parent: null,
        label: "root",
      },
      {
        id: "evt-002",
        at: "2024-01-01T00:01:00.000Z",
        t: "entry_placed",
        entryId: "kb-wolfpack-abc1234",
        sectionId: "sec-wp-000001",
        basis: "routed",
        fit: 0.85,
      },
    ];

    const sections = foldSections(events);
    const section = sections.find((s) => s.id === "sec-wp-000001");
    expect(section!.dirty).toBe(true);
  });

  it("handles section_split events", () => {
    const events: KbEvent[] = [
      {
        id: "evt-001",
        at: "2024-01-01T00:00:00.000Z",
        t: "section_created",
        sectionId: "sec-wp-000001",
        domain: "wolfpack",
        parent: null,
        label: "root",
      },
      {
        id: "evt-002",
        at: "2024-01-01T00:01:00.000Z",
        t: "section_split",
        sectionId: "sec-wp-000001",
        parentId: "sec-wp-000001",
        childIds: ["sec-wp-000002", "sec-wp-000003"],
      },
    ];

    const sections = foldSections(events);
    const section = sections.find((s) => s.id === "sec-wp-000001");
    expect(section!.childIds).toEqual([
      "sec-wp-000002" as SectionId,
      "sec-wp-000003" as SectionId,
    ]);
  });
});

describe("sections — helpers", () => {
  const mkSection = (
    id: string,
    domain: string,
    parent: string | null
  ): Section => ({
    id: id as SectionId,
    domain: domain as DomainId,
    parent: parent as SectionId | null,
    depth: parent ? 1 : 0,
    label: `section-${id}` as any,
    title: `Section ${id}`,
    centroid: new Array(768).fill(0),
    memberCount: 0,
    childIds: [],
    summary: "test",
    summaryHash: "",
    dirty: false,
    created: "2024-01-01" as any,
    updated: "2024-01-01" as any,
  });

  it("finds section by id", () => {
    const sections = [
      mkSection("sec-wp-000001", "wolfpack", null),
      mkSection("sec-wp-000002", "wolfpack", "sec-wp-000001"),
    ];

    const found = findSection(sections, "sec-wp-000002" as SectionId);
    expect(found).toBeDefined();
    expect(found!.id).toBe("sec-wp-000002" as SectionId);
  });

  it("gets children of a section", () => {
    const sections = [
      mkSection("sec-wp-000001", "wolfpack", null),
      mkSection("sec-wp-000002", "wolfpack", "sec-wp-000001"),
      mkSection("sec-wp-000003", "wolfpack", "sec-wp-000001"),
      mkSection("sec-wp-000004", "wolfpack", "sec-wp-000002"),
    ];

    const children = getChildren(sections, "sec-wp-000001" as SectionId);
    expect(children.length).toBe(2);
    expect(children.map((c) => c.id)).toContain("sec-wp-000002" as SectionId);
    expect(children.map((c) => c.id)).toContain("sec-wp-000003" as SectionId);
  });

  it("gets root sections for a domain", () => {
    const sections = [
      mkSection("sec-wp-000001", "wolfpack", null),
      mkSection("sec-wp-000002", "wolfpack", "sec-wp-000001"),
      mkSection("sec-sj-000001", "snapjack", null),
    ];

    const wpRoots = getRoots(sections, "wolfpack" as DomainId);
    expect(wpRoots.length).toBe(1);
    expect(wpRoots[0].id).toBe("sec-wp-000001" as SectionId);

    const sjRoots = getRoots(sections, "snapjack" as DomainId);
    expect(sjRoots.length).toBe(1);
    expect(sjRoots[0].id).toBe("sec-sj-000001" as SectionId);
  });

  it("builds parent index", () => {
    const sections = [
      mkSection("sec-wp-000001", "wolfpack", null),
      mkSection("sec-wp-000002", "wolfpack", "sec-wp-000001"),
      mkSection("sec-wp-000003", "wolfpack", "sec-wp-000001"),
    ];

    const index = buildParentIndex(sections);
    
    // Roots
    const roots = index.get(null);
    expect(roots).toBeDefined();
    expect(roots!.length).toBe(1);
    expect(roots![0].id).toBe("sec-wp-000001" as SectionId);
    
    // Children of sec-wp-000001
    const children = index.get("sec-wp-000001" as SectionId);
    expect(children).toBeDefined();
    expect(children!.length).toBe(2);
  });
});
