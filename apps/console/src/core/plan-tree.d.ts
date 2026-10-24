import type { PlanEdge, PlanNode, PlanTree } from "./contracts.ts";
/**
 * Pure, validated plan-tree operations (vision §2 "the formal plan tree").
 *
 * Every function takes a tree and returns a NEW tree — never mutates its
 * input. All validation throws PlanTreeError with a message written for the
 * agent (it flows straight back as a tool-result error), stating exactly what
 * is wrong and which id/edge is at fault.
 *
 * Invariants enforced everywhere:
 * - Node ids are unique and non-empty; every edge endpoint references an
 *   existing node.
 * - The structure is a DAG: no self-loops, no duplicate edges, no cycles.
 * - `version` increments on every successful STATE-CHANGING op. True no-ops
 *   (setCurrent to the already-current node, markDone of an already-done
 *   node) return the input tree unchanged — version drives UI re-animation,
 *   so a non-change must not tick it. createTree always starts at version 1.
 */
/** Error thrown by every op on invalid input. Message is agent-readable. */
export declare class PlanTreeError extends Error {
    constructor(message: string);
}
/** An empty, never-stored tree used as the seed before plan_init runs. */
export declare function emptyTree(): PlanTree;
/** Build a fresh tree (version 1) from node and edge lists, validating all invariants. */
export declare function createTree(nodes: PlanNode[], edges: PlanEdge[]): PlanTree;
//# sourceMappingURL=plan-tree.d.ts.map