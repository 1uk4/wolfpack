/**
 * route — the deterministic core of what the old design handed to a fat LLM
 * "assess" call. Registry alias lookup + embedding nearest-neighbour decide
 * create/merge; only the ambiguous residue escalates to an oracle.
 */
import type { ParsedContribution, Registry } from "../shared/index.js";
import type { RouteKind } from "../shared/index.js";
import { cosine, type Vector } from "./embed.js";
import type { Section, SectionId } from "../schema/knowledge.js";
import { HIERARCHY } from "@wolfpack/engine";

export interface EntryVector {
  entryId: string;
  canonicalId: string;
  domain: string;
  vector: Vector;
}

export interface RouteDecision {
  kind: RouteKind;
  /** Target entry id (merge/supersede) or null (create). */
  target: string | null;
  /** canonicalId when known via alias. */
  canonicalId: string | null;
  /** Best similarity score found, for logging/escalation. */
  score: number;
}

export interface RouteThresholds {
  /** At/above → treat as same entry (merge or conflict check). */
  duplicate: number;
  /** Between conflict and duplicate → maybe_conflict (escalate to oracle). */
  conflict: number;
}

// TODO(tuning): these are placeholders. nomic-embed-text has a COMPRESSED
// similarity range — a paraphrase scored only 0.62 on the live box, so 0.85
// will almost never fire. Recalibrate against a real corpus once Dewey has
// entries; expect something like duplicate ~0.75, conflict ~0.60. Revisit
// together with the search_document: prefix in embed.ts (both affect scores).
export const DEFAULT_ROUTE_THRESHOLDS: RouteThresholds = {
  duplicate: 0.85,
  conflict: 0.7,
};

/**
 * Decide the route for a contribution. Pure code.
 *   1. Alias in registry → merge_known (no LLM).
 *   2. Nearest entry ≥ duplicate → merge_near.
 *   3. conflict ≤ nearest < duplicate → maybe_conflict (oracle:contradict).
 *   4. Weak/absent domain hint → unclassified (oracle:classify).
 *   5. Otherwise → create.
 */
export function routeContribution(
  c: ParsedContribution,
  reg: Registry,
  vec: Vector,
  entryVectors: EntryVector[],
  thresholds: RouteThresholds = DEFAULT_ROUTE_THRESHOLDS
): RouteDecision {
  // 1. Known alias — strongest signal, zero LLM.
  for (const topic of reg.values()) {
    const alias = topic.aliases.find(
      (a) => a.wolf === c.from && a.denTopicId === c.denTopicId
    );
    if (alias) {
      return {
        kind: "merge_known",
        target: topic.entries[0] ?? null,
        canonicalId: topic.canonicalId,
        score: 1,
      };
    }
  }

  // 2/3. Nearest entry by embedding.
  let best: EntryVector | null = null;
  let bestScore = 0;
  for (const ev of entryVectors) {
    const s = cosine(vec, ev.vector);
    if (s > bestScore) {
      bestScore = s;
      best = ev;
    }
  }

  if (best && bestScore >= thresholds.duplicate) {
    return {
      kind: "merge_near",
      target: best.entryId,
      canonicalId: best.canonicalId,
      score: bestScore,
    };
  }
  if (best && bestScore >= thresholds.conflict) {
    return {
      kind: "maybe_conflict",
      target: best.entryId,
      canonicalId: best.canonicalId,
      score: bestScore,
    };
  }

  // 4. No match — classify if the hint is weak.
  if (!c.domainHint || c.domainHint.trim() === "") {
    return { kind: "unclassified", target: null, canonicalId: null, score: bestScore };
  }

  // 5. Novel, well-hinted → create.
  return { kind: "create", target: null, canonicalId: null, score: bestScore };
}

// ════════════════════════════════════════════════════════════════════════════
// Tree-descent routing (Phase 2 — KB v2)
// ════════════════════════════════════════════════════════════════════════════

export interface TreeRouteDecision {
  /** The section the entry should be placed in, or "_unplaced" if fit is too low. */
  section: SectionId | "_unplaced";
  /** The nearest entry within the section (for merge consideration). */
  target?: string;
  /** How the placement was determined. */
  basis: "routed" | "unplaced";
  /** Best fit score (cosine to section centroid or entry). */
  fit: number;
}

/**
 * Route a contribution by descending the section tree. Pure code, no LLM.
 * 
 * Algorithm:
 *  1. Start at root sections for the domain
 *  2. At each level, pick the child section with max cosine(vec, child.centroid)
 *  3. If best fit < HIERARCHY.fitThreshold → return "_unplaced"
 *  4. Otherwise descend to that child
 *  5. At a leaf section (no children), find nearest entry within the section
 *  6. Cap descent at HIERARCHY.maxDepth
 */
export function routeByTree(
  vec: Vector,
  domain: string,
  sections: Section[],
  entryVectors: EntryVector[]
): TreeRouteDecision {
  // Find root sections for this domain
  const roots = sections.filter((s) => s.parent === null && s.domain === domain);
  
  if (roots.length === 0) {
    // No section tree yet → unplaced
    return { section: "_unplaced", basis: "unplaced", fit: 0 };
  }

  let currentLevel = roots;
  let currentSection: Section | null = null;
  let currentDepth = 0;

  // Descend the tree
  while (currentLevel.length > 0 && currentDepth < HIERARCHY.maxDepth) {
    // Find best-fitting section at this level
    let bestSection: Section | null = null;
    let bestFit = -1;

    for (const section of currentLevel) {
      const fit = cosine(vec, section.centroid);
      if (fit > bestFit) {
        bestFit = fit;
        bestSection = section;
      }
    }

    if (!bestSection) {
      return { section: "_unplaced", basis: "unplaced", fit: bestFit };
    }

    currentSection = bestSection;

    // Get children for next level
    const children = sections.filter((s) => s.parent === bestSection!.id);
    
    if (children.length === 0) {
      // Reached a leaf section - check fitThreshold here
      if (bestFit < HIERARCHY.fitThreshold) {
        return { section: "_unplaced", basis: "unplaced", fit: bestFit };
      }
      break;
    }

    // Continue descending (don't check fitThreshold at intermediate nodes)
    currentLevel = children;
    currentDepth++;
  }

  // If we exited due to maxDepth, check fitThreshold
  if (currentSection) {
    const finalFit = cosine(vec, currentSection.centroid);
    if (finalFit < HIERARCHY.fitThreshold) {
      return { section: "_unplaced", basis: "unplaced", fit: finalFit };
    }
  }

  if (!currentSection) {
    return { section: "_unplaced", basis: "unplaced", fit: 0 };
  }

  // At the leaf section, find nearest entry within it
  const sectionEntries = entryVectors.filter((ev) => {
    // We don't have section info on EntryVector yet, so for now we use
    // proximity to section centroid as a proxy. In production, entries
    // would track their section.
    return cosine(ev.vector, currentSection!.centroid) >= HIERARCHY.fitThreshold * 0.9;
  });

  let nearestEntry: string | undefined;
  let bestEntrySim = -1;

  for (const ev of sectionEntries) {
    const sim = cosine(vec, ev.vector);
    if (sim > bestEntrySim) {
      bestEntrySim = sim;
      nearestEntry = ev.entryId;
    }
  }

  return {
    section: currentSection.id,
    target: nearestEntry,
    basis: "routed",
    fit: cosine(vec, currentSection.centroid),
  };
}
