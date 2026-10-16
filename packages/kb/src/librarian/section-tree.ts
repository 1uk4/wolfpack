/**
 * section-tree.ts — New section tree algorithm for KB v2.
 *
 * Implements agglomerative hierarchical clustering for full rebuilds and
 * recursive descent placement for incremental updates. The tree serves as
 * a navigable taxonomy: entries are leaves, sections are internal nodes.
 */
import { SECTION_TREE } from "@wolfpack/engine";
import { cosine, type Vector } from "./embed.js";
import { computeCentroid, type EntryWithVector } from "./hierarchy.js";
import type { Section, SectionId, DomainId } from "../schema/knowledge.js";

// ════════════════════════════════════════════════════════════════════════════
// Types
// ════════════════════════════════════════════════════════════════════════════

interface Cluster {
  id: string;
  centroid: Vector;
  members: EntryWithVector[];
  children: Cluster[];
  weight: number; // total member count including all descendants
}

interface Violation {
  type: string;
  section: SectionId;
  [key: string]: unknown;
}

interface PlacementResult {
  sectionId: SectionId | "_unplaced";
  fit: number;
  depth: number;
}

interface SplitResult {
  parentMembers: EntryWithVector[];
  childSection: Section;
  childMembers: EntryWithVector[];
  reassignment: Map<string, SectionId>;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Build Tree Bottom-Up (Agglomerative Clustering)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Agglomerative hierarchical clustering that produces a section tree.
 * 
 * Algorithm:
 * 1. Each entry starts as its own cluster
 * 2. Compute pairwise cosine similarity between all cluster centroids
 * 3. Find the two most similar clusters
 * 4. Merge them: new centroid = weighted mean of the two centroids
 * 5. Repeat until cluster count reaches target root count
 * 6. Convert merge tree into Section objects
 */
export interface BuildTreeResult {
  sections: Section[];
  /** Map of entryId → leaf sectionId (which section each entry belongs to) */
  assignments: Map<string, SectionId>;
}

export function buildTreeBottomUp(
  entries: EntryWithVector[],
  domain: string,
  domainCentroid: Vector,
  config = SECTION_TREE,
  /** Entry metadata for abstraction scoring (entryId → { kind, maturity }) */
  entryMeta?: Map<string, { kind?: string; maturity?: string }>
): BuildTreeResult {
  if (entries.length === 0) return { sections: [], assignments: new Map() };
  const assignments = new Map<string, SectionId>();

  // Target number of root sections
  const targetRoots = Math.max(
    1,
    Math.round(Math.sqrt(entries.length) * config.rootCountFactor)
  );

  // Initialize: each entry as its own cluster
  let clusters: Cluster[] = entries.map((entry, idx) => ({
    id: `leaf-${idx}`,
    centroid: entry.vector,
    members: [entry],
    children: [],
    weight: 1,
  }));

  // Agglomerative merge loop — stop when similarity drops below floor
  // or cluster count reaches target, whichever comes first.
  const MERGE_SIMILARITY_FLOOR = 0.65;

  while (clusters.length > targetRoots) {
    // Compute pairwise similarity matrix
    let maxSim = -1;
    let mergeI = -1;
    let mergeJ = -1;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = cosine(clusters[i].centroid, clusters[j].centroid);
        if (sim > maxSim) {
          maxSim = sim;
          mergeI = i;
          mergeJ = j;
        }
      }
    }

    if (mergeI === -1 || mergeJ === -1) break; // safety: no valid merge found

    // Stop merging when the best available pair isn't similar enough.
    // Whatever clusters remain at this point are the natural roots.
    if (maxSim < MERGE_SIMILARITY_FLOOR) break;

    // Merge the two most similar clusters
    const clusterA = clusters[mergeI];
    const clusterB = clusters[mergeJ];
    const weightA = clusterA.weight;
    const weightB = clusterB.weight;
    const totalWeight = weightA + weightB;

    // Weighted mean centroid
    const mergedCentroid = new Array(clusterA.centroid.length);
    for (let k = 0; k < mergedCentroid.length; k++) {
      mergedCentroid[k] =
        (clusterA.centroid[k] * weightA + clusterB.centroid[k] * weightB) / totalWeight;
    }

    const merged: Cluster = {
      id: `merge-${clusters.length}`,
      centroid: normalize(mergedCentroid),
      members: [...clusterA.members, ...clusterB.members],
      children: [clusterA, clusterB],
      weight: totalWeight,
    };

    // Remove merged clusters and add new one
    const newClusters: Cluster[] = [];
    for (let i = 0; i < clusters.length; i++) {
      if (i !== mergeI && i !== mergeJ) {
        newClusters.push(clusters[i]);
      }
    }
    newClusters.push(merged);
    clusters = newClusters;
  }

  // Convert cluster tree to Section objects
  const sections: Section[] = [];
  const sectionIds = new Map<string, SectionId>();
  const today = new Date().toISOString().split("T")[0];

  // Convert clusters to sections.
  // Each root cluster becomes a root section.
  // If a root cluster is large (> splitThreshold), find its natural
  // sub-clusters by collecting leaf-level groupings from the merge tree.
  function collectLeafClusters(cluster: Cluster, minSize: number): Cluster[] {
    // If small enough, this is a leaf section
    if (cluster.weight <= minSize || cluster.children.length === 0) {
      return [cluster];
    }
    // Otherwise, recurse into children
    const result: Cluster[] = [];
    for (const child of cluster.children) {
      result.push(...collectLeafClusters(child, minSize));
    }
    return result;
  }

  // Force-split oversized leaf clusters using k-means
  function ensureSplitThreshold(leafClusters: Cluster[]): Cluster[] {
    const result: Cluster[] = [];
    for (const cluster of leafClusters) {
      if (cluster.weight <= config.splitThreshold) {
        result.push(cluster);
        continue;
      }
      // Split via k-means into 2
      const vectors = cluster.members.map((m) => m.vector);
      const { assignment, clusters: centroids } = kMeans2(vectors);
      const groupA: EntryWithVector[] = [];
      const groupB: EntryWithVector[] = [];
      for (let i = 0; i < cluster.members.length; i++) {
        (assignment[i] === 0 ? groupA : groupB).push(cluster.members[i]);
      }
      // Recurse in case sub-clusters are still too large
      const subA: Cluster = {
        id: `split-a-${cluster.id}`,
        centroid: centroids[0],
        members: groupA,
        children: [],
        weight: groupA.length,
      };
      const subB: Cluster = {
        id: `split-b-${cluster.id}`,
        centroid: centroids[1],
        members: groupB,
        children: [],
        weight: groupB.length,
      };
      result.push(...ensureSplitThreshold([subA, subB]));
    }
    return result;
  }

  function buildSection(
    cluster: Cluster,
    parentId: SectionId | null,
    depth: number,
  ): void {
    const sectionId = mkSectionId(domain as DomainId);

    if (cluster.weight <= config.splitThreshold) {
      // Leaf section — record entry assignments
      for (const m of cluster.members) {
        assignments.set(m.entryId, sectionId);
      }
      sections.push({
        id: sectionId,
        domain: domain as unknown as DomainId,
        parent: parentId,
        depth,
        label: sectionId.slice(-7) as any,
        title: "",
        centroid: cluster.centroid,
        memberCount: cluster.weight,
        childIds: [],
        summary: "",
        summaryHash: "",
        dirty: true, memberCountAtLastLabel: 0,
        created: today as any,
        updated: today as any,
      });
      return;
    }

    // Large cluster: collect leaf sub-clusters from merge tree, then force-split
    let subClusters = collectLeafClusters(cluster, config.splitThreshold);
    subClusters = ensureSplitThreshold(subClusters);

    const childIds: SectionId[] = [];
    const childSections: Array<{ id: SectionId; centroid: Vector; members: EntryWithVector[] }> = [];
    const singletons: EntryWithVector[] = [];

    for (const sub of subClusters) {
      if (sub.weight < 2) {
        // Collect singletons — will assign to nearest child after
        singletons.push(...sub.members);
        continue;
      }
      const childId = mkSectionId(domain as DomainId);
      childIds.push(childId);
      childSections.push({ id: childId, centroid: sub.centroid, members: [...sub.members] });
      for (const m of sub.members) assignments.set(m.entryId, childId);
      sections.push({
        id: childId,
        domain: domain as unknown as DomainId,
        parent: sectionId,
        depth: depth + 1,
        label: childId.slice(-7) as any,
        title: "",
        centroid: sub.centroid,
        memberCount: sub.weight,
        childIds: [],
        summary: "",
        summaryHash: "",
        dirty: true, memberCountAtLastLabel: 0,
        created: today as any,
        updated: today as any,
      });
    }

    // Distribute singletons to their nearest child section
    if (singletons.length > 0 && childSections.length > 0) {
      for (const entry of singletons) {
        let bestChild = childSections[0];
        let bestSim = -1;
        for (const child of childSections) {
          const sim = cosine(entry.vector, child.centroid);
          if (sim > bestSim) { bestSim = sim; bestChild = child; }
        }
        bestChild.members.push(entry);
      }
    } else {
      // No children — singletons are direct members
      for (const m of singletons) {
        assignments.set(m.entryId, sectionId);
      }
    }
    
    // Final enforcement: re-split any child that exceeds threshold
    // This handles singletons that inflated a child past the limit
    const finalChildren: typeof childSections = [];
    for (const child of childSections) {
      if (child.members.length <= config.splitThreshold) {
        finalChildren.push(child);
        continue;
      }
      // Convert back to clusters and force-split
      const oversized: Cluster = {
        id: child.id as string,
        centroid: child.centroid,
        members: child.members,
        children: [],
        weight: child.members.length,
      };
      const splitResult = ensureSplitThreshold([oversized]);
      for (const sub of splitResult) {
        finalChildren.push({
          id: mkSectionId(domain as DomainId),
          centroid: sub.centroid,
          members: sub.members,
        });
      }
      // Remove the original oversized section
      const idx = sections.findIndex((s) => s.id === child.id);
      if (idx >= 0) sections.splice(idx, 1);
      const cidx = childIds.indexOf(child.id);
      if (cidx >= 0) childIds.splice(cidx, 1);
    }
    
    // Create final child sections and record assignments
    for (const child of finalChildren) {
      if (!sections.some((s) => s.id === child.id)) {
        childIds.push(child.id);
        sections.push({
          id: child.id,
          domain: domain as unknown as DomainId,
          parent: sectionId,
          depth: depth + 1,
          label: (child.id as string).slice(-7) as any,
          title: "",
          centroid: child.centroid,
          memberCount: child.members.length,
          childIds: [],
          summary: "",
          summaryHash: "",
          dirty: true, memberCountAtLastLabel: 0,
          created: today as any,
          updated: today as any,
        });
      }
      for (const m of child.members) assignments.set(m.entryId, child.id);    
    }


    sections.push({
      id: sectionId,
      domain: domain as unknown as DomainId,
      parent: parentId,
      depth,
      label: sectionId.slice(-7) as any,
      title: "",
      centroid: cluster.centroid,
      memberCount: singletons.length > 0 && childSections.length === 0 ? singletons.length : 0,
      childIds,
      summary: "",
      summaryHash: "",
      dirty: true, memberCountAtLastLabel: 0,
      created: today as any,
      updated: today as any,
    });
  }

  // Abstraction-aware root merge: DISABLED.
  // This was collapsing natural roots back into a single tree by merging
  // "specific" clusters into "general" ones, recreating binary chains.
  // The similarity floor in the merge loop already produces coherent roots.
  if (false && entryMeta && clusters.length > 1) {
    function clusterAbstraction(cluster: Cluster): number {
      let totalScore = 0;
      for (const m of cluster.members) {
        const meta = entryMeta!.get(m.entryId);
        const kindScore = config.abstractionByKind[meta?.kind ?? ""] ?? config.defaultAbstraction;
        const matMult = config.maturityMultiplier[meta?.maturity ?? ""] ?? 1.0;
        totalScore += Math.min(1, kindScore * matMult);
      }
      return totalScore / cluster.members.length;
    }

    // A root cluster is "too specific" if its average abstraction score > 0.6
    // (meaning it's dominated by incident/changelog/fact entries)
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = clusters.length - 1; i >= 0; i--) {
        const score = clusterAbstraction(clusters[i]);
        if (score <= 0.6 || clusters.length <= 2) continue;
        
        // Find the nearest general cluster to absorb into
        let bestIdx = -1;
        let bestSim = -1;
        for (let j = 0; j < clusters.length; j++) {
          if (j === i) continue;
          if (clusterAbstraction(clusters[j]) > 0.6) continue; // skip other specific clusters
          const sim = cosine(clusters[i].centroid, clusters[j].centroid);
          if (sim > bestSim) { bestSim = sim; bestIdx = j; }
        }
        
        if (bestIdx >= 0) {
          // Merge specific cluster into the general one
          const target = clusters[bestIdx];
          const source = clusters[i];
          const totalWeight = target.weight + source.weight;
          const mergedCentroid = new Array(target.centroid.length);
          for (let k = 0; k < mergedCentroid.length; k++) {
            mergedCentroid[k] = (target.centroid[k] * target.weight + source.centroid[k] * source.weight) / totalWeight;
          }
          clusters[bestIdx] = {
            id: target.id,
            centroid: normalize(mergedCentroid),
            members: [...target.members, ...source.members],
            children: [target, source],
            weight: totalWeight,
          };
          clusters.splice(i, 1);
          merged = true;
          break;
        }
      }
    }
  }

  for (const cluster of clusters) {
    buildSection(cluster, null, 0);
  }

  // Post-build: enforce maxChildrenPerSection recursively on all sections
  enforceBranchingFactor(sections, domain, config);

  // Collapse empty root wrappers: any root section with 0 direct entries
  // promotes its children to root level. Prevents meaningless wrappers.
  let collapseChanged = true;
  while (collapseChanged) {
    collapseChanged = false;
    const roots = sections.filter(s => s.parent === null && String(s.domain) === domain);
    for (const root of roots) {
      const rootEntries = [...assignments.values()].filter(sid => sid === root.id);
      if (rootEntries.length === 0 && root.childIds.length > 0) {
        for (const cid of root.childIds) {
          const child = sections.find(s => s.id === cid);
          if (child) {
            child.parent = null;
            child.depth = 0;
            const fixDepth = (parentId: SectionId, d: number) => {
              for (const s of sections) {
                if (s.parent === parentId) { s.depth = d; fixDepth(s.id, d + 1); }
              }
            };
            fixDepth(child.id, 1);
          }
        }
        const idx = sections.indexOf(root);
        if (idx >= 0) sections.splice(idx, 1);
        collapseChanged = true;
        break;
      }
    }
  }

  // Collapse binary wrapper sections at ALL depths: a section with 0 direct
  // entries and EXACTLY 2 children is a binary-split artifact. Promote the
  // 2 children to this section's parent. Wrappers with 3+ children are kept.
  // Uses ACTUAL children (sections with parent === sec.id), not sec.childIds
  // which can be out of sync.
  let binaryCollapsed = true;
  while (binaryCollapsed) {
    binaryCollapsed = false;
    for (const sec of [...sections]) {
      if (String(sec.domain) !== domain) continue;
      const actualChildren = sections.filter(s => s.parent === sec.id);
      if (actualChildren.length !== 2) continue;
      const secEntries = [...assignments.values()].filter(sid => sid === sec.id);
      if (secEntries.length === 0) {
        for (const child of actualChildren) {
          child.parent = sec.parent;
          child.depth = sec.depth;
          if (sec.parent) {
            const parent = sections.find(s => s.id === sec.parent);
            if (parent && !parent.childIds.includes(child.id)) {
              parent.childIds.push(child.id);
            }
          }
          const fixDepth = (parentId: SectionId, d: number) => {
            for (const s of sections) {
              if (s.parent === parentId) { s.depth = d; fixDepth(s.id, d + 1); }
            }
          };
          fixDepth(child.id, child.depth + 1);
        }
        if (sec.parent) {
          const parent = sections.find(s => s.id === sec.parent);
          if (parent) parent.childIds = parent.childIds.filter(c => c !== sec.id);
        }
        const idx = sections.indexOf(sec);
        if (idx >= 0) sections.splice(idx, 1);
        binaryCollapsed = true;
        break;
      }
    }
  }

  return { sections, assignments };
}

// ════════════════════════════════════════════════════════════════════════════
// 2. Place Entry (Recursive Descent)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Recursive descent placement for a single new entry.
 * 
 * Algorithm:
 * 1. Compute abstraction score from entry metadata
 * 2. Find root sections for the domain
 * 3. Recursive descent:
 *    - Compute cosine similarity to each child section's centroid
 *    - Best match = highest similarity
 *    - If best similarity < isolationThreshold → unplaced
 *    - If abstractionScore <= normalizedDepth → stop (too general to go deeper)
 *    - If best child has children, continue descending
 *    - Otherwise place here
 */
export function placeEntry(
  entryVector: Vector,
  entryMeta: { kind?: string; maturity?: string },
  sections: Section[],
  domainCentroid: Vector,
  sectionMembers: Map<string, EntryWithVector[]>,
  config = SECTION_TREE
): PlacementResult {
  // Compute abstraction score
  let abstractionScore =
    config.abstractionByKind[entryMeta.kind ?? ""] ?? config.defaultAbstraction;
  
  // Apply maturity multiplier
  const maturityMult =
    config.maturityMultiplier[entryMeta.maturity ?? ""] ?? 1.0;
  abstractionScore *= maturityMult;
  
  // Clamp to [0, 1]
  abstractionScore = Math.max(0, Math.min(1, abstractionScore));

  // Find domain from first section (assume all sections belong to same domain)
  if (sections.length === 0) {
    return { sectionId: "_unplaced", fit: 0, depth: 0 };
  }

  const domain = sections[0].domain;
  const roots = sections.filter((s) => s.parent === null && s.domain === domain);
  
  if (roots.length === 0) {
    return { sectionId: "_unplaced", fit: 0, depth: 0 };
  }

  // Compute max tree depth
  const maxTreeDepth = Math.max(...sections.map((s) => s.depth), 1);

  // Recursive descent helper
  function descend(candidates: Section[], currentDepth: number): PlacementResult {
    // Find best matching candidate
    let bestSection: Section | null = null;
    let bestSim = -1;

    for (const section of candidates) {
      const sim = cosine(entryVector, section.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestSection = section;
      }
    }

    if (!bestSection || bestSim < config.isolationThreshold) {
      return { sectionId: "_unplaced", fit: bestSim, depth: currentDepth };
    }

    // Check if entry is too general to descend further
    const normalizedDepth = currentDepth / maxTreeDepth;
    if (abstractionScore <= normalizedDepth) {
      return { sectionId: bestSection.id, fit: bestSim, depth: currentDepth };
    }

    // Get children of best section
    const children = sections.filter((s) => s.parent === bestSection!.id);
    
    if (children.length === 0) {
      // Leaf section - place here
      return { sectionId: bestSection.id, fit: bestSim, depth: currentDepth };
    }

    // Continue descending
    return descend(children, currentDepth + 1);
  }

  return descend(roots, 0);
}

// ════════════════════════════════════════════════════════════════════════════
// 3. Split as Parent-Child
// ════════════════════════════════════════════════════════════════════════════

/**
 * Split an oversized section into parent + child (NOT two siblings).
 * 
 * Algorithm:
 * 1. k-means with k=2 on member vectors
 * 2. Compute centroids for both clusters
 * 3. Determine parent based on config strategy:
 *    - "domain_centrality": cluster closer to domain centroid is parent
 *    - "size": larger cluster is parent
 * 4. Parent keeps original section ID, child gets new ID
 */
export function splitAsParentChild(
  section: Section,
  members: EntryWithVector[],
  domainCentroid: Vector,
  sections: Section[],
  config = SECTION_TREE
): SplitResult {
  if (members.length < 2) {
    throw new Error("Cannot split section with fewer than 2 members");
  }

  // Run k-means with k=2
  const vectors = members.map((m) => m.vector);
  const { clusters, assignment } = kMeans2(vectors);

  // Split members into two groups
  const cluster0Members: EntryWithVector[] = [];
  const cluster1Members: EntryWithVector[] = [];

  for (let i = 0; i < members.length; i++) {
    if (assignment[i] === 0) {
      cluster0Members.push(members[i]);
    } else {
      cluster1Members.push(members[i]);
    }
  }

  // Determine which cluster becomes parent
  let parentMembers: EntryWithVector[];
  let childMembers: EntryWithVector[];

  if (config.splitParentStrategy === "domain_centrality") {
    const sim0 = cosine(clusters[0], domainCentroid);
    const sim1 = cosine(clusters[1], domainCentroid);
    if (sim0 >= sim1) {
      parentMembers = cluster0Members;
      childMembers = cluster1Members;
    } else {
      parentMembers = cluster1Members;
      childMembers = cluster0Members;
    }
  } else {
    // "size" strategy
    if (cluster0Members.length >= cluster1Members.length) {
      parentMembers = cluster0Members;
      childMembers = cluster1Members;
    } else {
      parentMembers = cluster1Members;
      childMembers = cluster0Members;
    }
  }

  // Create child section
  const childId = mkSectionId(section.domain);
  const today = new Date().toISOString().split("T")[0];
  
  const childSection: Section = {
    id: childId,
    domain: section.domain,
    parent: section.id,
    depth: section.depth + 1,
    label: `${section.label}-child` as any,
    title: "",
    centroid: computeCentroid(childMembers.map((m) => m.vector)),
    memberCount: childMembers.length,
    childIds: [],
    summary: "",
    summaryHash: "",
    dirty: true, memberCountAtLastLabel: 0,
    created: today as any,
    updated: today as any,
  };

  // Build reassignment map
  const reassignment = new Map<string, SectionId>();
  for (const member of childMembers) {
    reassignment.set(member.entryId, childId);
  }

  return {
    parentMembers,
    childSection,
    childMembers,
    reassignment,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 4. Check Invariants
// ════════════════════════════════════════════════════════════════════════════

/**
 * Post-mutation health check. Returns a list of violations with suggested fixes.
 * 
 * Checks:
 * 1. Weight inversion: parent must have >= child's total entries
 * 2. Singleton roots: root sections below minRootRatio of domain entries
 * 3. Empty sections: sections with 0 members and 0 children
 */
export function checkInvariants(
  sections: Section[],
  domain: string,
  sectionMembers: Map<string, EntryWithVector[]>,
  totalDomainEntries: number,
  config = SECTION_TREE
): Violation[] {
  const violations: Violation[] = [];

  // Build a map of section ID to section for quick lookup
  const sectionMap = new Map<string, Section>();
  for (const s of sections) {
    sectionMap.set(s.id, s);
  }

  // Helper to get total entries (recursive)
  function getTotalEntries(sectionId: SectionId): number {
    const section = sectionMap.get(sectionId);
    if (!section) return 0;
    
    let total = sectionMembers.get(sectionId)?.length ?? 0;
    for (const childId of section.childIds) {
      total += getTotalEntries(childId);
    }
    return total;
  }

  // 1. Check weight inversion
  for (const section of sections) {
    const parentTotal = getTotalEntries(section.id);
    for (const childId of section.childIds) {
      const childTotal = getTotalEntries(childId);
      if (parentTotal < childTotal) {
        violations.push({
          type: "weight_inversion",
          section: section.id,
          parent: section.id,
          child: childId,
        });
      }
    }
  }

  // 2. Check singleton roots
  const roots = sections.filter((s) => s.parent === null && s.domain === domain);
  const minRootEntries = totalDomainEntries * config.minRootRatio;

  for (const root of roots) {
    const rootEntries = getTotalEntries(root.id);
    if (rootEntries < minRootEntries) {
      // Find nearest neighbor among other roots
      let nearestNeighbor: SectionId | null = null;
      let bestSim = -1;
      
      for (const other of roots) {
        if (other.id !== root.id) {
          const sim = cosine(root.centroid, other.centroid);
          if (sim > bestSim) {
            bestSim = sim;
            nearestNeighbor = other.id;
          }
        }
      }

      if (nearestNeighbor) {
        violations.push({
          type: "singleton_root",
          section: root.id,
          nearestNeighbor,
        });
      }
    }
  }

  // 3. Check empty sections
  for (const section of sections) {
    const memberCount = sectionMembers.get(section.id)?.length ?? 0;
    if (memberCount === 0 && section.childIds.length === 0) {
      violations.push({
        type: "empty",
        section: section.id,
      });
    }
  }

  return violations;
}

// ════════════════════════════════════════════════════════════════════════════
// 5. Should Recalculate (Drift Detection)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Simple drift check. Returns boolean.
 */
export function shouldRecalculate(
  mutationsSinceLastRecalc: number,
  totalEntries: number,
  config = SECTION_TREE
): boolean {
  return totalEntries > 0 && (mutationsSinceLastRecalc / totalEntries) >= config.driftRecalcThreshold;
}

// ════════════════════════════════════════════════════════════════════════════
// Utilities
// ════════════════════════════════════════════════════════════════════════════

/** Generate a random section ID. */
function mkSectionId(domain: DomainId): SectionId {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return `sec-${domain}-${id}` as unknown as SectionId;
}

/** Normalize a vector to unit length. */
function normalize(v: Vector): Vector {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  return norm > 0 ? v.map((x) => x / norm) : v;
}

/**
 * Recursively enforce maxChildrenPerSection on all sections.
 * If a section has too many children, group them via k-means into
 * intermediate sub-sections. Repeats until no section exceeds the limit.
 */
/**
 * Enforce branching factor by grouping similar children into intermediate
 * sections. Only creates a group when 3+ children form a coherent cluster
 * (pairwise similarity above threshold). Children that don't cluster stay
 * as direct children — no forced grouping.
 */
function enforceBranchingFactor(
  sections: Section[],
  domain: string,
  config: typeof SECTION_TREE,
): void {
  const today = new Date().toISOString().split("T")[0];
  const MIN_GROUP_SIZE = 3;
  const GROUP_SIMILARITY_THRESHOLD = 0.70;

  let changed = true;
  while (changed) {
    changed = false;
    for (const sec of [...sections]) {
      if (sec.domain !== domain) continue;
      if (sec.childIds.length <= config.maxChildrenPerSection) continue;

      const childSecs = sec.childIds
        .map((cid) => sections.find((s) => s.id === cid)!)
        .filter(Boolean);
      if (childSecs.length < 2) continue;

      // Try k-means with increasing k until groups are coherent
      const k = Math.ceil(childSecs.length / config.maxChildrenPerSection);
      if (k < 2) continue;

      const { assignment } = kMeans2Multi(childSecs.map((s) => s.centroid), k);

      const rawGroups = new Map<number, Section[]>();
      for (let i = 0; i < childSecs.length; i++) {
        const g = assignment[i];
        if (!rawGroups.has(g)) rawGroups.set(g, []);
        rawGroups.get(g)!.push(childSecs[i]);
      }

      // Filter: only create a wrapper for groups with 3+ members AND
      // sufficient internal similarity. Everything else stays ungrouped.
      const newChildIds: SectionId[] = [];
      let didGroup = false;

      for (const [, group] of rawGroups) {
        if (group.length < MIN_GROUP_SIZE) {
          // Too small to group — keep as direct children
          for (const child of group) newChildIds.push(child.id);
          continue;
        }

        // Check cohesion: average pairwise similarity within the group
        let pairSum = 0;
        let pairCount = 0;
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            pairSum += cosine(group[i].centroid, group[j].centroid);
            pairCount++;
          }
        }
        const avgSim = pairCount > 0 ? pairSum / pairCount : 0;

        if (avgSim < GROUP_SIMILARITY_THRESHOLD) {
          // Not coherent enough — keep as direct children
          for (const child of group) newChildIds.push(child.id);
          continue;
        }

        // Create wrapper section for this coherent group
        const groupId = mkSectionId(domain as DomainId);
        const groupCentroid = computeCentroid(group.map((s) => s.centroid));
        const groupChildIds: SectionId[] = [];
        for (const child of group) {
          child.parent = groupId;
          child.depth = sec.depth + 2;
          groupChildIds.push(child.id);
        }
        sections.push({
          id: groupId,
          domain: domain as unknown as DomainId,
          parent: sec.id,
          depth: sec.depth + 1,
          label: groupId.slice(-7) as any,
          title: "",
          centroid: groupCentroid,
          memberCount: 0,
          childIds: groupChildIds,
          summary: "",
          summaryHash: "",
          dirty: true, memberCountAtLastLabel: 0,
          created: today as any,
          updated: today as any,
        } as Section);
        newChildIds.push(groupId);
        didGroup = true;
      }

      if (didGroup) {
        sec.childIds = newChildIds;
        sec.dirty = true;
        changed = true;
      }
    }
  }
}

/** Simple k-means with k=2. */
function kMeans2(vectors: Vector[], maxIter: number = 10): {
  clusters: [Vector, Vector];
  assignment: number[];
} {
  if (vectors.length < 2) {
    const centroid = vectors.length === 1 ? vectors[0] : new Array(768).fill(0);
    return {
      clusters: [centroid, centroid],
      assignment: vectors.map(() => 0),
    };
  }

  const dim = vectors[0].length;
  const n = vectors.length;

  // Initialize: pick two random vectors as initial centroids
  const idx0 = Math.floor(Math.random() * n);
  let idx1 = Math.floor(Math.random() * n);
  while (idx1 === idx0 && n > 1) {
    idx1 = Math.floor(Math.random() * n);
  }

  let centroids: [Vector, Vector] = [vectors[idx0], vectors[idx1]];
  let assignment = new Array(n).fill(0);

  // Iterate
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // Assign each vector to nearest centroid
    for (let i = 0; i < n; i++) {
      const sim0 = cosine(vectors[i], centroids[0]);
      const sim1 = cosine(vectors[i], centroids[1]);
      const newAssignment = sim0 >= sim1 ? 0 : 1;
      if (assignment[i] !== newAssignment) {
        assignment[i] = newAssignment;
        changed = true;
      }
    }

    if (!changed) break;

    // Recompute centroids
    const cluster0 = vectors.filter((_, i) => assignment[i] === 0);
    const cluster1 = vectors.filter((_, i) => assignment[i] === 1);

    if (cluster0.length > 0) {
      centroids[0] = computeCentroid(cluster0);
    }
    if (cluster1.length > 0) {
      centroids[1] = computeCentroid(cluster1);
    }
  }

  return { clusters: centroids, assignment };
}

/** k-means for arbitrary k. Used for grouping children when branching factor is too high. */
function kMeans2Multi(vectors: Vector[], k: number, maxIter: number = 10): {
  centroids: Vector[];
  assignment: number[];
} {
  if (vectors.length <= k) {
    return { centroids: [...vectors], assignment: vectors.map((_, i) => i) };
  }

  // Initialize centroids by picking k evenly spaced vectors
  const step = Math.floor(vectors.length / k);
  const centroids: Vector[] = [];
  for (let i = 0; i < k; i++) {
    centroids.push([...vectors[i * step]]);
  }

  const assignment = new Array(vectors.length).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // Assign each vector to nearest centroid
    for (let i = 0; i < vectors.length; i++) {
      let bestCluster = 0;
      let bestSim = -1;
      for (let c = 0; c < k; c++) {
        const sim = cosine(vectors[i], centroids[c]);
        if (sim > bestSim) { bestSim = sim; bestCluster = c; }
      }
      if (assignment[i] !== bestCluster) {
        assignment[i] = bestCluster;
        changed = true;
      }
    }

    if (!changed) break;

    // Recompute centroids
    for (let c = 0; c < k; c++) {
      const members = vectors.filter((_, i) => assignment[i] === c);
      if (members.length > 0) {
        centroids[c] = computeCentroid(members);
      }
    }
  }

  return { centroids, assignment };
}
