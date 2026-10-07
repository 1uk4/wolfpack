/**
 * hierarchy.ts — BIRCH-style emergent section mechanics (PURE, no LLM).
 *
 * Controls how the section tree grows:
 *  - maybeSplit: overflow → k-means(2) → new child sections
 *  - crystallizeUnplaced: cohesive clusters from _unplaced → new sections
 *  - mergeSmall: underfull sections fold back into parent
 *
 * All deterministic; centroid updates use running mean; section summary text
 * is left as a Phase 3 LLM call (hook with TODO).
 */
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";
import type { Vector } from "./embed.js";
import { cosine } from "./embed.js";
import { HIERARCHY } from "@wolfpack/engine";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

export interface EntryWithVector {
  entryId: string;
  sectionId: SectionId;
  vector: Vector;
}

export interface SplitResult {
  /** The new child sections created. */
  children: Section[];
  /** Mapping of entryId → new sectionId. */
  reassignment: Map<string, SectionId>;
}

export interface CrystallizationCandidate {
  /** The new section to create. */
  section: Section;
  /** Entry ids that belong to this section. */
  entryIds: string[];
  /** Cohesion score (silhouette coefficient). */
  cohesion: number;
}

// ════════════════════════════════════════════════════════════════════════════
// Centroid utilities
// ════════════════════════════════════════════════════════════════════════════

/** Compute the mean centroid of a set of vectors. */
export function computeCentroid(vectors: Vector[]): Vector {
  if (vectors.length === 0) return new Array(768).fill(0);
  const dim = vectors[0].length;
  const centroid = new Array(dim).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += v[i];
    }
  }
  for (let i = 0; i < dim; i++) {
    centroid[i] /= vectors.length;
  }
  return normalize(centroid);
}

/** Update a centroid with a new vector using running mean. */
export function updateCentroid(
  currentCentroid: Vector,
  currentCount: number,
  newVector: Vector
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

// ════════════════════════════════════════════════════════════════════════════
// Split (BIRCH overflow)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Split an overfull section using k-means(k=2). Returns new child sections
 * and the reassignment map. The parent section should have its childIds updated
 * and be marked dirty.
 */
export function maybeSplit(
  section: Section,
  members: EntryWithVector[]
): SplitResult | null {
  if (members.length <= HIERARCHY.splitAt) return null;

  // k-means with k=2
  const clusters = kMeans(
    members.map((m) => m.vector),
    2,
    10 // max iterations
  );

  // Create two child sections
  const children: Section[] = [];
  const reassignment = new Map<string, SectionId>();

  for (let i = 0; i < 2; i++) {
    const clusterMembers = members.filter((_, idx) => clusters.assignment[idx] === i);
    if (clusterMembers.length === 0) continue;

    const childId = mkSectionId(section.domain);
    const child: Section = {
      id: childId,
      domain: section.domain,
      parent: section.id,
      depth: section.depth + 1,
      label: `${section.label}-${i + 1}` as any,
      title: `${section.title} (split ${i + 1})`,
      centroid: clusters.centroids[i],
      memberCount: clusterMembers.length,
      childIds: [],
      summary: "", // TODO(Phase 3): LLM call to generate summary
      summaryHash: "",
      dirty: true,
      created: now() as any,
      updated: now() as any,
    };

    children.push(child);

    for (const m of clusterMembers) {
      reassignment.set(m.entryId, childId);
    }
  }

  return { children, reassignment };
}

// ════════════════════════════════════════════════════════════════════════════
// Crystallize (novelty clustering from _unplaced)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Find cohesive clusters in the parked (_unplaced) entries and propose new
 * sections for them. Sparse strays remain parked.
 */
export function crystallizeUnplaced(
  parked: EntryWithVector[],
  existingSections: Section[],
  domain: DomainId
): CrystallizationCandidate[] {
  if (parked.length < HIERARCHY.crystallizeAt) return [];

  // Cluster the parked entries
  const vectors = parked.map((p) => p.vector);
  const k = Math.min(Math.floor(parked.length / HIERARCHY.crystallizeAt), 5);
  if (k < 1) return [];

  const clusters = kMeans(vectors, k, 10);

  const candidates: CrystallizationCandidate[] = [];

  for (let i = 0; i < k; i++) {
    const clusterMembers = parked.filter((_, idx) => clusters.assignment[idx] === i);
    if (clusterMembers.length < HIERARCHY.crystallizeAt) continue;

    // Compute cohesion (average pairwise similarity within cluster)
    const cohesion = computeCohesion(clusterMembers.map((m) => m.vector));
    if (cohesion < HIERARCHY.minCohesion) continue;

    // Find nearest existing section to determine parent
    const nearestParent = findNearestSection(
      clusters.centroids[i],
      existingSections,
      domain
    );

    const sectionId = mkSectionId(domain);
    const section: Section = {
      id: sectionId,
      domain,
      parent: nearestParent?.id ?? null,
      depth: nearestParent ? nearestParent.depth + 1 : 0,
      label: `crystallized-${sectionId.slice(-6)}` as any,
      title: `Crystallized section ${sectionId.slice(-6)}`,
      centroid: clusters.centroids[i],
      memberCount: clusterMembers.length,
      childIds: [],
      summary: "", // TODO(Phase 3): LLM call to generate summary
      summaryHash: "",
      dirty: true,
      created: now() as any,
      updated: now() as any,
    };

    candidates.push({
      section,
      entryIds: clusterMembers.map((m) => m.entryId),
      cohesion,
    });
  }

  return candidates;
}

// ════════════════════════════════════════════════════════════════════════════
// Merge (fold underfull sections back into parent)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Check if a section should be merged back into its parent. Returns the parent
 * section id if merge is needed, null otherwise.
 */
export function shouldMerge(section: Section): SectionId | null {
  if (section.parent === null) return null; // can't merge root
  if (section.memberCount >= HIERARCHY.mergeBelow) return null;
  return section.parent;
}

// ════════════════════════════════════════════════════════════════════════════
// Clustering utilities (k-means)
// ════════════════════════════════════════════════════════════════════════════

interface KMeansResult {
  centroids: Vector[];
  assignment: number[];
}

/**
 * Simple k-means clustering. Returns k centroids and assignment array.
 */
function kMeans(vectors: Vector[], k: number, maxIter: number = 10): KMeansResult {
  if (vectors.length === 0 || k === 0) {
    return { centroids: [], assignment: [] };
  }
  if (k === 1) {
    return { centroids: [computeCentroid(vectors)], assignment: vectors.map(() => 0) };
  }

  const dim = vectors[0].length;
  const n = vectors.length;

  // Initialize centroids using k-means++ for better initial placement
  const centroids: Vector[] = [];
  centroids.push(vectors[Math.floor(Math.random() * n)]);

  for (let i = 1; i < k; i++) {
    const distances: number[] = [];
    for (const v of vectors) {
      const minDist = Math.min(
        ...centroids.map((c) => 1 - cosine(v, c))
      );
      distances.push(minDist * minDist);
    }
    const sum = distances.reduce((a, b) => a + b, 0);
    let r = Math.random() * sum;
    for (let j = 0; j < n; j++) {
      r -= distances[j];
      if (r <= 0) {
        centroids.push(vectors[j]);
        break;
      }
    }
  }

  let assignment = new Array(n).fill(0);

  // Iterate
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // Assign each vector to nearest centroid
    for (let i = 0; i < n; i++) {
      let bestCluster = 0;
      let bestSim = cosine(vectors[i], centroids[0]);
      for (let j = 1; j < k; j++) {
        const sim = cosine(vectors[i], centroids[j]);
        if (sim > bestSim) {
          bestSim = sim;
          bestCluster = j;
        }
      }
      if (assignment[i] !== bestCluster) {
        assignment[i] = bestCluster;
        changed = true;
      }
    }

    if (!changed) break;

    // Recompute centroids
    for (let j = 0; j < k; j++) {
      const clusterVectors = vectors.filter((_, i) => assignment[i] === j);
      if (clusterVectors.length > 0) {
        centroids[j] = computeCentroid(clusterVectors);
      }
    }
  }

  return { centroids, assignment };
}

/**
 * Compute cohesion using average pairwise cosine similarity (approximates
 * silhouette coefficient for a single cluster).
 */
function computeCohesion(vectors: Vector[]): number {
  if (vectors.length < 2) return 1.0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      sum += cosine(vectors[i], vectors[j]);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

/**
 * Find the nearest existing section to a vector, considering only sections
 * in the same domain and below maxDepth.
 */
function findNearestSection(
  vector: Vector,
  sections: Section[],
  domain: DomainId
): Section | null {
  let best: Section | null = null;
  let bestSim = -1;

  for (const s of sections) {
    if (s.domain !== domain) continue;
    if (s.depth >= HIERARCHY.maxDepth - 1) continue; // leave room for child
    const sim = cosine(vector, s.centroid);
    if (sim > bestSim) {
      bestSim = sim;
      best = s;
    }
  }

  return best;
}

// ════════════════════════════════════════════════════════════════════════════
// ID generation
// ════════════════════════════════════════════════════════════════════════════

function mkSectionId(domain: DomainId): SectionId {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `sec-${domain}-${id}` as SectionId;
}

function now(): string {
  return new Date().toISOString().split("T")[0];
}
