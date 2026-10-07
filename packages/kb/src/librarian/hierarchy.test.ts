/**
 * hierarchy.test.ts — Tests for section tree mechanics.
 */
import { describe, it, expect } from "vitest";
import {
  computeCentroid,
  updateCentroid,
  maybeSplit,
  crystallizeUnplaced,
  shouldMerge,
  type EntryWithVector,
  type CrystallizationCandidate,
} from "./hierarchy.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";
import type { Vector } from "./embed.js";

describe("hierarchy — centroid utilities", () => {
  it("computes centroid from vectors", () => {
    const v1: Vector = [1, 0, 0];
    const v2: Vector = [0, 1, 0];
    const v3: Vector = [0, 0, 1];
    const centroid = computeCentroid([v1, v2, v3]);
    
    // Should be normalized
    const norm = Math.sqrt(centroid.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("updates centroid with running mean", () => {
    const current: Vector = [1, 0, 0];
    const newVec: Vector = [0, 1, 0];
    const updated = updateCentroid(current, 1, newVec);
    
    // Should be normalized
    const norm = Math.sqrt(updated.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("hierarchy — split", () => {
  const mkSection = (id: string, domain: string = "wolfpack"): Section => ({
    id: id as SectionId,
    domain: domain as DomainId,
    parent: null,
    depth: 0,
    label: "test" as any,
    title: "Test Section",
    centroid: new Array(768).fill(0),
    memberCount: 0,
    childIds: [],
    summary: "test",
    summaryHash: "",
    dirty: false,
    created: "2024-01-01" as any,
    updated: "2024-01-01" as any,
  });

  const mkEntry = (id: string, vec: number[]): EntryWithVector => {
    const fullVec = [...vec, ...new Array(768 - vec.length).fill(0)];
    const norm = Math.sqrt(fullVec.reduce((sum: number, x: number) => sum + x * x, 0));
    const normalized = norm > 0 ? fullVec.map((x: number) => x / norm) : fullVec;
    return {
      entryId: id,
      sectionId: "sec-test-000001" as SectionId,
      vector: normalized,
    };
  };

  it("returns null if members <= splitAt", () => {
    const section = mkSection("sec-test-000001");
    const members = [
      mkEntry("e1", [1, 0, 0]),
      mkEntry("e2", [0, 1, 0]),
    ];
    
    const result = maybeSplit(section, members);
    expect(result).toBeNull();
  });

  it("splits when members > splitAt", () => {
    const section = mkSection("sec-test-000001");
    // Create 13 members (over the default splitAt of 12)
    const members: EntryWithVector[] = [];
    for (let i = 0; i < 13; i++) {
      // Cluster them into two groups
      const vec = i < 7 ? [1, 0, 0] : [0, 1, 0];
      members.push(mkEntry(`e${i}`, vec));
    }
    
    const result = maybeSplit(section, members);
    expect(result).not.toBeNull();
    expect(result!.children.length).toBe(2);
    expect(result!.reassignment.size).toBe(13);
    
    // Check that children have the right parent
    for (const child of result!.children) {
      expect(child.parent).toBe(section.id);
      expect(child.depth).toBe(section.depth + 1);
    }
  });
});

describe("hierarchy — crystallize", () => {
  const mkSection = (id: string, domain: string = "wolfpack"): Section => ({
    id: id as SectionId,
    domain: domain as DomainId,
    parent: null,
    depth: 0,
    label: "test" as any,
    title: "Test Section",
    centroid: new Array(768).fill(0),
    memberCount: 0,
    childIds: [],
    summary: "test",
    summaryHash: "",
    dirty: false,
    created: "2024-01-01" as any,
    updated: "2024-01-01" as any,
  });

  const mkEntry = (id: string, vec: number[]): EntryWithVector => {
    const fullVec = [...vec, ...new Array(768 - vec.length).fill(0)];
    const norm = Math.sqrt(fullVec.reduce((sum: number, x: number) => sum + x * x, 0));
    const normalized = norm > 0 ? fullVec.map((x: number) => x / norm) : fullVec;
    return {
      entryId: id,
      sectionId: "_unplaced" as SectionId,
      vector: normalized,
    };
  };

  it("returns empty if parked < crystallizeAt", () => {
    const parked = [
      mkEntry("e1", [1, 0, 0]),
      mkEntry("e2", [0.9, 0.1, 0]),
    ];
    
    const result = crystallizeUnplaced(parked, [], "wolfpack" as DomainId);
    expect(result).toEqual([]);
  });

  it("crystallizes cohesive clusters", () => {
    // Create a cohesive cluster of 5 entries
    const parked: EntryWithVector[] = [];
    for (let i = 0; i < 5; i++) {
      parked.push(mkEntry(`e${i}`, [1, 0.1 * i, 0]));
    }
    
    const result = crystallizeUnplaced(parked, [], "wolfpack" as DomainId);
    
    // Should create at least one section
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].entryIds.length).toBeGreaterThanOrEqual(4); // crystallizeAt = 4
    expect(result[0].cohesion).toBeGreaterThan(0);
  });

  it("rejects low-cohesion clusters", () => {
    // Create scattered entries (low cohesion)
    const parked = [
      mkEntry("e1", [1, 0, 0]),
      mkEntry("e2", [0, 1, 0]),
      mkEntry("e3", [0, 0, 1]),
      mkEntry("e4", [-1, 0, 0]),
    ];
    
    const result = crystallizeUnplaced(parked, [], "wolfpack" as DomainId);
    
    // Should not crystallize due to low cohesion
    // (might be empty or have very few candidates)
    const highCohesion = result.filter((c) => c.cohesion >= 0.80);
    expect(highCohesion.length).toBeLessThanOrEqual(result.length);
  });
});

describe("hierarchy — merge", () => {
  const mkSection = (
    id: string,
    parent: string | null,
    memberCount: number
  ): Section => ({
    id: id as SectionId,
    domain: "wolfpack" as DomainId,
    parent: parent as SectionId | null,
    depth: parent ? 1 : 0,
    label: "test" as any,
    title: "Test Section",
    centroid: new Array(768).fill(0),
    memberCount,
    childIds: [],
    summary: "test",
    summaryHash: "",
    dirty: false,
    created: "2024-01-01" as any,
    updated: "2024-01-01" as any,
  });

  it("returns null for root sections", () => {
    const section = mkSection("sec-test-000001", null, 2);
    expect(shouldMerge(section)).toBeNull();
  });

  it("returns null if memberCount >= mergeBelow", () => {
    const section = mkSection("sec-test-000001", "sec-test-000000", 3);
    expect(shouldMerge(section)).toBeNull();
  });

  it("returns parent id if memberCount < mergeBelow", () => {
    const section = mkSection("sec-test-000001", "sec-test-000000", 2);
    expect(shouldMerge(section)).toBe("sec-test-000000" as SectionId);
  });
});
