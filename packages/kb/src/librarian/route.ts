/**
 * route — the deterministic core of what the old design handed to a fat LLM
 * "assess" call. Registry alias lookup + embedding nearest-neighbour decide
 * create/merge; only the ambiguous residue escalates to an oracle.
 */
import { cosine, type Vector } from "./embed.js";
import type { Section, SectionId } from "../schema/knowledge.js";
import { HIERARCHY } from "@wolfpack/engine";

export interface EntryVector {
  entryId: string;
  canonicalId: string;
  domain: string;
  vector: Vector;
}

// ════════════════════════════════════════════════════════════════════════════
// Tree-descent routing (hierarchical section placement)
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
