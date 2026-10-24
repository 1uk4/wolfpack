import type { GraphSnapshot } from "../core/contracts.ts";
import type { GraphCostSummary } from "../core/cost-summary.ts";
import { type NodeDeletionStats } from "../core/graph-deletion.ts";
/**
 * Server-side graph entry for the home view (GET /api/graph). A PURE READ:
 * the extraction pipeline (the sole graph writer) is triggered by quiz
 * answers in sessions (turn-service), never from here — the home view
 * reflects whatever the pipeline has merged so far.
 */
export declare function graphView(): GraphSnapshot;
/** The graph view's cost surface (GET /api/graph/costs — the 2026-09 cost
 *  pill): fold every usage channel into stage totals + recent runs. A pure
 *  read over the chat records (chat-front-door runs), the notes sources
 *  (notes-front-door runs), and the naming ledger (graph-global runs);
 *  dollars are inferred by the pure core fold (core/cost-summary.ts +
 *  prices.ts) — nothing here stores or caches money. */
export declare function graphCosts(): GraphCostSummary;
/** The graph's version stamp (session-deletion wave 6): the max mtime
 * across every graph data file — ledgers, positions. Moves on ANY
 * graph write (merge append, settle, or a deletion's atomic rewrite),
 * never moves on reads, and needs no bookkeeping of its own: the fs
 * IS the counter. Consumers poll it (the activity feed
 *  carries it; the DELETE response returns it) to know clusters/layout
 *  must refetch — the "graph changed underneath me" signal. */
export declare function graphRevision(): number;
/** What deleteGraphNode did — the route maps it straight to HTTP. */
export type NodeDeleteOutcome = {
    ok: false;
    status: 404;
    code: "not_found";
    error: string;
} | {
    ok: false;
    status: 409;
    code: "extraction_running";
    error: string;
} | {
    ok: true;
    stats: NodeDeletionStats;
    graphRevision: number;
};
/**
 * Delete one node by id — FULL DEATH (core/graph-deletion.ts for the
 * ledger semantics). The guard family is deliberately NOT the chat
 * one, and the reasoning is worth writing down:
 *
 *   - No turn/jobs gates. Turns and background jobs never write the
 *     graph ledgers; a turn's follow-up extraction registers as a run,
 *     and every code path here is synchronous — nothing can register
 *     or merge between the gate and the ledger rewrite (the event loop
 *     never yields inside this function).
 *   - THE EXTRACTION GATE — 409 while ANY pipeline run is registered,
 *     anywhere. A mid-flight run holds findings extracted from
 *     transcripts that predate the deletion; its merges could re-add
 *     aliases, provenance, or events to the dying node (the
 *     re-reference risk the dispatch flags). Unlike chat deletion we
 *     do NOT abort the run: it belongs to some session, and killing
 *     that session's spend is outside this deletion's blast radius —
 *     the UI retries once the dock drains. A run that starts AFTER
 *     the deletion is legitimate re-learning: it reads post-deletion
 *     ledgers, mints a fresh node for a re-taught topic, and
 *     mergeFindings ignores linkTo ids that no longer exist (the
 *     existingIds guard) — no dangling edges, no resurrection.
 */
export declare function deleteGraphNode(nodeId: string): NodeDeleteOutcome;
//# sourceMappingURL=graph.d.ts.map