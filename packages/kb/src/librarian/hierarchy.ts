/**
 * hierarchy.ts — section-tree math shared by rebuild + incremental reorg.
 *
 * The structural passes (split / crystallize / rebalance) live in
 * `section-tree.ts` and `reorg.ts`. This module is the small pure helper
 * surface — centroid math, the merge predicate, and the entry+vector shape
 * — kept so unit tests have a single import target.
 */
import type { Section, SectionId } from "../schema/knowledge.js";
import type { Vector } from "./embed.js";
import { HIERARCHY } from "@wolfpack/engine";

export interface EntryWithVector {
  entryId: string;
  sectionId: SectionId;
  vector: Vector;
}

/** Compute the mean centroid of a set of vectors, normalized. */
export function computeCentroid(vectors: Vector[]): Vector {
  if (vectors.length === 0) return new Array(768).fill(0);
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) centroid[i] += v[i];
  }
  for (let i = 0; i < dim; i++) centroid[i] /= vectors.length;
  return normalize(centroid);
}

/** Update a centroid with a new vector using running mean. */
export function updateCentroid(
  currentCentroid: Vector,
  currentCount: number,
  newVector: Vector,
): Vector {
  if (currentCount === 0) return normalize(newVector);
  const dim = currentCentroid.length;
  const updated = new Array(dim);
  for (let i = 0; i < dim; i++) {
    updated[i] =
      (currentCentroid[i] * currentCount + newVector[i]) / (currentCount + 1);
  }
  return normalize(updated);
}

function normalize(v: Vector): Vector {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

/**
 * Check if a section should be merged back into its parent. Returns the
 * parent section id if merge is needed, null otherwise.
 */
export function shouldMerge(section: Section): SectionId | null {
  if (section.parent === null) return null;
  if (section.childIds.length > 0) return null;
  if (section.memberCount >= HIERARCHY.mergeBelow) return null;
  return section.parent;
}
