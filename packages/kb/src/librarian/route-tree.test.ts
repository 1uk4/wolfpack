/**
 * route-tree.test.ts — Tests for tree-descent routing.
 */
import { describe, it, expect } from "vitest";
import { routeByTree, type EntryVector } from "./route.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";
import type { Vector } from "./embed.js";

describe("routeByTree — deterministic tree-descent router", () => {
  const mkSection = (
    id: string,
    domain: string,
    parent: string | null,
    depth: number,
    centroid: number[]
  ): Section => {
    const fullCentroid = [...centroid, ...new Array(768 - centroid.length).fill(0)];
    const norm = Math.sqrt(fullCentroid.reduce((sum: number, x: number) => sum + x * x, 0));
    const normalized = norm > 0 ? fullCentroid.map((x: number) => x / norm) : fullCentroid;
    
    return {
      id: id as SectionId,
      domain: domain as DomainId,
      parent: parent as SectionId | null,
      depth,
      label: `section-${id}` as any,
      title: `Section ${id}`,
      centroid: normalized,
      memberCount: 0,
      childIds: [],
      summary: "test",
      summaryHash: "",
      dirty: false,
      created: "2024-01-01" as any,
      updated: "2024-01-01" as any,
    };
  };

  const mkVec = (coords: number[]): Vector => {
    const fullVec = [...coords, ...new Array(768 - coords.length).fill(0)];
    const norm = Math.sqrt(fullVec.reduce((sum: number, x: number) => sum + x * x, 0));
    return norm > 0 ? fullVec.map((x: number) => x / norm) : fullVec;
  };

  it("returns _unplaced when no sections exist", () => {
    const vec = mkVec([1, 0, 0]);
    const result = routeByTree(vec, "wolfpack", [], []);
    
    expect(result.section).toBe("_unplaced");
    expect(result.basis).toBe("unplaced");
  });

  it("routes to root section when no children", () => {
    const root = mkSection("sec-wp-000001", "wolfpack", null, 0, [1, 0, 0]);
    const vec = mkVec([0.9, 0.1, 0]);
    
    const result = routeByTree(vec, "wolfpack", [root], []);
    
    expect(result.section).toBe("sec-wp-000001" as SectionId);
    expect(result.basis).toBe("routed");
    expect(result.fit).toBeGreaterThan(0);
  });

  it("descends to best-fitting child", () => {
    const root = mkSection("sec-wp-000001", "wolfpack", null, 0, [1, 0, 0]);
    const child1 = mkSection("sec-wp-000002", "wolfpack", "sec-wp-000001", 1, [1, 0.1, 0]);
    const child2 = mkSection("sec-wp-000003", "wolfpack", "sec-wp-000001", 1, [0, 1, 0]);
    
    const sections = [root, child1, child2];
    
    // Vector close to child1
    const vec1 = mkVec([0.95, 0.05, 0]);
    const result1 = routeByTree(vec1, "wolfpack", sections, []);
    expect(result1.section).toBe("sec-wp-000002" as SectionId);
    
    // Vector close to child2
    const vec2 = mkVec([0.05, 0.95, 0]);
    const result2 = routeByTree(vec2, "wolfpack", sections, []);
    expect(result2.section).toBe("sec-wp-000003" as SectionId);
  });

  it("returns _unplaced if fit < fitThreshold", () => {
    const root = mkSection("sec-wp-000001", "wolfpack", null, 0, [1, 0, 0]);
    const sections = [root];
    
    // Vector orthogonal to root (low fit)
    const vec = mkVec([0, 0, 1]);
    const result = routeByTree(vec, "wolfpack", sections, []);
    
    expect(result.section).toBe("_unplaced");
    expect(result.basis).toBe("unplaced");
  });

  it("caps descent at maxDepth", () => {
    // Create a deep tree
    const sections: Section[] = [];
    sections.push(mkSection("sec-wp-000001", "wolfpack", null, 0, [1, 0, 0]));
    
    for (let i = 1; i < 6; i++) {
      const parentId = `sec-wp-00000${i}`;
      const childId = `sec-wp-00000${i + 1}`;
      sections.push(mkSection(childId, "wolfpack", parentId, i, [1, 0, 0]));
    }
    
    const vec = mkVec([1, 0, 0]);
    const result = routeByTree(vec, "wolfpack", sections, []);
    
    // Should route to some section, not descend infinitely
    expect(result.section).not.toBe("_unplaced");
  });

  it("deterministically routes same vector to same section", () => {
    const root = mkSection("sec-wp-000001", "wolfpack", null, 0, [1, 0, 0]);
    const child1 = mkSection("sec-wp-000002", "wolfpack", "sec-wp-000001", 1, [1, 0.1, 0]);
    const child2 = mkSection("sec-wp-000003", "wolfpack", "sec-wp-000001", 1, [0, 1, 0]);
    
    const sections = [root, child1, child2];
    const vec = mkVec([0.9, 0.2, 0]);
    
    // Call multiple times
    const result1 = routeByTree(vec, "wolfpack", sections, []);
    const result2 = routeByTree(vec, "wolfpack", sections, []);
    const result3 = routeByTree(vec, "wolfpack", sections, []);
    
    // Should always route to the same section
    expect(result1.section).toBe(result2.section);
    expect(result2.section).toBe(result3.section);
  });

  it("respects domain boundaries", () => {
    const wpRoot = mkSection("sec-wp-000001", "wolfpack", null, 0, [1, 0, 0]);
    const sjRoot = mkSection("sec-sj-000001", "snapjack", null, 0, [1, 0, 0]);
    
    const sections = [wpRoot, sjRoot];
    const vec = mkVec([1, 0, 0]);
    
    // Should route to wolfpack section
    const wpResult = routeByTree(vec, "wolfpack", sections, []);
    expect(wpResult.section).toBe("sec-wp-000001" as SectionId);
    
    // Should route to snapjack section
    const sjResult = routeByTree(vec, "snapjack", sections, []);
    expect(sjResult.section).toBe("sec-sj-000001" as SectionId);
  });
});
