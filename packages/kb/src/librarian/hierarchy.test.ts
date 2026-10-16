/**
 * hierarchy.test.ts — pure helper tests.
 *
 * Split / crystallize moved to section-tree.ts (see its tests). What's left
 * is centroid math and the merge predicate.
 */
import { describe, it, expect } from "vitest";
import {
  computeCentroid,
  updateCentroid,
  shouldMerge,
} from "./hierarchy.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";
import type { Vector } from "./embed.js";

describe("hierarchy — centroid utilities", () => {
  it("computes centroid from vectors", () => {
    const v1: Vector = [1, 0, 0];
    const v2: Vector = [0, 1, 0];
    const v3: Vector = [0, 0, 1];
    const centroid = computeCentroid([v1, v2, v3]);
    const norm = Math.sqrt(centroid.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("updates centroid with running mean", () => {
    const current: Vector = [1, 0, 0];
    const newVec: Vector = [0, 1, 0];
    const updated = updateCentroid(current, 1, newVec);
    const norm = Math.sqrt(updated.reduce((sum, x) => sum + x * x, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("hierarchy — merge", () => {
  const mkSection = (
    id: string,
    parent: string | null,
    memberCount: number,
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
    memberCountAtLastLabel: 0,
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
