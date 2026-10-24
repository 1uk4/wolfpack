/**
 * The layout engine — d3-force, everywhere (DECIDED 2026-09-13).
 *
 * One engine owns the equilibrium: the merge-time incremental settle AND
 * the live drag physics run the SAME force set (links as springs, charge
 * repulsion, weak gravity), so the positions ledger and the transient
 * simulation agree on what "resting" means. (FA2 was replaced after a
 * research round: it has no annealing/pinning/settle model and mixing it
 * with a different live engine visibly re-flows the graph on every drag.)
 *
 * Layout EVOLVES instead of reshuffling (Option A): each settle warm-starts
 * from the positions ledger and spring-ties every previously-positioned
 * node toward its anchor (a per-node anchor force). New nodes seed near
 * their positioned neighbors; orphans seed on the rim OUTSIDE the core and
 * are anchored there, so they read as "not yet connected knowledge".
 *
 * Design constraints (kept deliberately, for live physics):
 *  - PURE: no fs, no server types — this module runs server-side (the
 *    merge settle) and in the browser (the live simulation, via the core
 *    barrel). A pinned node is just fx/fy; an anchored node is a spring.
 *  - DETERMINISTIC: seeds derive from node id; d3-force ticks are
 *    deterministic — same inputs, same layout.
 */
import { type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import type { GraphNode, Position } from "./contracts.ts";
/** A node the d3 simulation mutates (x/y/vx/vy; fx/fy = pinned). */
export interface LayoutNode extends SimulationNodeDatum {
    id: string;
}
/** A link as d3 sees it (id strings resolve to node refs on init). */
type SimLink = SimulationLinkDatum<LayoutNode>;
/** How the inference rank is expressed spatially (playground, 2026-09-13):
 *  the graph's `follows`/`supports` edges encode derivation (premise →
 *  conclusion), so depth-0 nodes (no incoming edges — the fundamentals)
 *  can anchor a shared baseline and every derivation level rises from it.
 *  `vertical`: levels are horizontal rows, arrows point up.
 *  `radial`: levels are concentric rings, foundations at the center, the
 *  outer boundary IS the edge of the user's knowledge.
 *  `off`: today's free layout. */
export type DepthAnchorMode = "off" | "vertical" | "radial";
export interface DepthAnchor {
    mode: DepthAnchorMode;
    /** Anchor pull toward the level (same units as clusterPull). */
    strength: number;
    /** Distance between consecutive inference levels (world units). */
    spacing: number;
    /** Baseline point: vertical mode uses .y as the depth-0 line; radial
     *  mode uses the full point as the ring center. Default (0,0). */
    center?: {
        x: number;
        y: number;
    };
    /** Inner ring radius (radial only; depth-0 nodes sit at this ring). */
    baseRadius?: number;
}
/** Inference depth per node: the longest chain of directed edges from a
 * base node. CYCLE-SAFE (2026-09-13, user requirement — the DAG property
 * is typical, not guaranteed): Tarjan SCC condensation collapses each
 * strongly connected component to one super-node, ranks the (always
 * acyclic) condensation, and every cycle member shares its component's
 * depth — mutual support reads as equal footing. Iterative Tarjan (no
 * recursion depth limits), O(V+E), deterministic. */
export declare function inferenceDepths(nodes: ReadonlyArray<Pick<GraphNode, "id">>, edges: ReadonlyArray<LayoutEdge>): Map<string, number>;
export interface SimOptions {
    /** Link spring rest length (world units). */
    linkDistance?: number;
    /** Link spring stiffness MULTIPLIER (1 = d3's default
     *  1/min(degree) stiffness). */
    linkStrength?: number;
    /** Many-body repulsion strength (negative). */
    chargeStrength?: number;
    /** Center-of-mass gravity: pulls loose components inward. Weak —
     *  anchors, not gravity, hold the evolved layout's frame. */
    gravity?: {
        x: number;
        y: number;
        strength: number;
    };
    /** Alpha decay per tick — higher = snappier settle. The merge settle
     *  uses d3's default 0.0228 (~300 ticks); the live sim passes ~0.05. */
    alphaDecay?: number;
    /** Velocity damping per tick (d3 default 0.4). Higher = more friction. */
    velocityDecay?: number;
    /** Inference-depth anchoring (see DepthAnchor). Off by default. */
    depthAnchor?: DepthAnchor;
    /** The LOGICAL edge list (proposition→conclusion, imp hops
     *  contracted) for the depth machinery — orphan detection AND the
     *  rank pass (owner, 2026-09-30). Absent = `edges` (legacy
     *  behavior). Springs ALWAYS run over `edges` — the drawn arrows. */
    logicalEdges?: ReadonlyArray<LayoutEdge>;
    /** The derived imp nodes' chain linkage (id + members), straight
     *  from deriveView. Drives the IMP MIDPOINT ANCHOR (owner,
     *  2026-09-30): an implication node's depth is the average of the
     *  HIGHEST premise row and the conclusion's row — strictly above
     *  every premise, strictly below the conclusion, uniform in vertical
     *  (a row) and radial (a ring) modes. Absent = imp nodes keep the
     *  legacy orphan exemption (never depth-anchored). */
    impLinks?: ReadonlyArray<ImpLink>;
    /** Cluster centroid pull (the "virtual node" without the node):
     *  members of each cluster accelerate toward their own cluster's
     *  centroid. Two O(n) passes per tick — cheaper than a real virtual
     *  node (which would need one extra link spring per member plus a
     *  maintained position). Strength 0 or absent = force off.
     *  Callers supply the partition (Louvain output shape). */
    clusterPull?: {
        clusters: ReadonlyArray<{
            members: ReadonlyArray<string>;
        }>;
        strength: number;
    };
}
/** Link input: edges are undirected for layout purposes. */
export interface LayoutEdge {
    from: string;
    to: string;
}
/** A derived implication node's chain linkage — what the depth pass needs
 *  to anchor the junction between its premises and their conclusion. */
export interface ImpLink {
    /** The imp node's id (arg_-prefixed — the stored chain's id). */
    id: string;
    premises: ReadonlyArray<string>;
    conclusion: string;
}
export declare const LINK_DISTANCE = 40;
export declare const CHARGE_STRENGTH = -240;
/** Exported: the live sim reuses this so its rest state matches the
 *  server settle's equilibrium (one engine, one rest). */
export declare const INCREMENTAL_GRAVITY = 0.12;
/** Exported: default cluster-centroid pull strength (tuned by replay —
 *  compact enough to read as blobs, weak enough that cluster shape is
 *  still the edge network's). */
export declare const CLUSTER_PULL_STRENGTH = 0.15;
/**
 * The one force set. Returns a STOPPED simulation — callers drive it
 * manually (tick-per-frame live, or a bounded tick loop when settling).
 * Deterministic; mutates `nodes` in place (d3 semantics: impure by design,
 * zero per-tick allocation).
 */
export declare function createGraphSimulation(nodes: LayoutNode[], edges: ReadonlyArray<LayoutEdge>, options?: SimOptions): Simulation<LayoutNode, SimLink>;
export interface IncrementalLayoutOptions {
    /** Manual ticks for the settle (default 300 — d3's anneal to alphaMin). */
    ticks?: number;
    /** Per-tick anchor re-blend (default 0.85; 1 = fully pinned). */
    anchorRetention?: number;
    /** Center-of-mass gravity strength override (tuning/A-B experiments;
     *  defaults to the internal bootstrap/incremental constants). */
    gravityStrength?: number;
    /** Cluster partition (Louvain output shape). Supplied by callers so
     *  this module stays louvain-free (the browser bundle must not carry
     *  embedding ledger; absent = no cluster pull. */
    clusters?: ReadonlyArray<{
        members: ReadonlyArray<string>;
    }>;
    /** Cluster centroid pull strength (default CLUSTER_PULL_STRENGTH). */
    clusterPullStrength?: number;
    /** Inference-depth anchoring (see DepthAnchor). `center` defaults to
     *  the anchored core's centroid. */
    depthAnchor?: DepthAnchor;
    /** The LOGICAL edge list for the depth pass (see SimOptions). */
    logicalEdges?: ReadonlyArray<LayoutEdge>;
    /** The imp chain linkage for the midpoint anchor (see SimOptions). */
    impLinks?: ReadonlyArray<ImpLink>;
}
/**
 * One incremental settle. `nodes`/`edges` describe the CURRENT graph;
 * `previous` is the positions ledger (empty on the very first settle —
 * then this degrades to a seeded-scatter bootstrap). Returns positions
 * for EVERY node in `nodes`.
 */
export declare function incrementalLayout(nodes: ReadonlyArray<Pick<GraphNode, "id">>, edges: ReadonlyArray<LayoutEdge>, previous: ReadonlyMap<string, Position>, options?: IncrementalLayoutOptions): Map<string, Position>;
export {};
//# sourceMappingURL=layout.d.ts.map