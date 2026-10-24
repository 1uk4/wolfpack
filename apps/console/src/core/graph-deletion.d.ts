/**
 * Session deletion — the FIRST destructive operation on the append-only
 * graph ledgers (owner ruling 2026-09-22, wave 6 chunk A).
 *
 * Until now mergeFindings has been the sole writer; deletion is the second,
 * and it is held to the same discipline: PURE code over the storage ports
 * (core/ports.ts), no LLM judgment anywhere, deterministic and idempotent.
 * The caller (the DELETE /api/chats/[id] route through the server
 * orchestration) owns the cross-store choreography (chat record, jobs,
 * extraction wind-down); this module owns the LEDGERS.
 *
 * CHAINS-PRIMARY (owner, 2026-09-30): the stored truth is propositions +
 * reasoning chains; edges are a derived view. Deletion therefore operates
 * on CHAIN LINES where it used to operate on edge lines — a chain dies
 * when its provenance empties or any member node died — and the derived
 * view follows on the next read, never rewritten here.
 *
 * Two modes (owner-locked semantics):
 *
 *   preserve-graph  the chat's extraction bookkeeping dies — its coverage
 *                   rows and its legacy checkpoint lines — and NOTHING else:
 *                   nodes and chains stay byte-identical.
 *                   The graph keeps the session's contributions; the
 *                   snapshot simply no longer resolves the dead chatId to
 *                   a title (nodeSessions filters unknown ids at read
 *                   time — no UI ghosting).
 *
 *   delete-nodes    "this session never happened": every trace of the
 *                   chat leaves the ledgers — its provenance points on
 *                   every node and chain line, its link lines (their
 *                   phrasings die with them), its coverage/checkpoint
 *                   rows — and orphans die: a node
 *                   whose references all came from this chat disappears
 *                   entirely, pruned from the positions ledger too (dead
 *                   members would break cluster hulls).
 *
 * Shared nodes survive automatically (the ruling): a node lives iff ANY
 * surviving reference remains — a provenance point from another chat or
 * notes source. The create line of a surviving node is special:
 * name/statement/createdAt are the node's IDENTITY — the shared anchor
 * other sessions' link verdicts recognized — so they stay even when the
 * deleted chat created the node; but that session's phrasings (the line's
 * aliases) are stripped and its provenance points removed (owner ruling
 * 2026-09-23: all traces, identity survives).
 *
 * Not touched, by design:
 *   - imported-notes sources (src_…) — a different front door with its
 *     own lifecycle (re-import dedupes by path hash); this wave deletes
 *     CHATS.
 *
 * Resurrection safety: the deletion runs as ONE synchronous block (no
 * awaits — atomic vs the event loop, so no extraction append can
 * interleave), and the extraction pipeline re-checks the chat record
 * before each batch's merge (a deleted chat never merges). Both seams
 * together close every corrupt/resurrect path.
 */
import type { GraphStore } from "./ports.ts";
/** The two deletion modes (owner-locked 2026-09-22). Machine-checkable on
 *  the API as the required `mode` query param — no default, so no
 *  accidental destructive choice. */
export type ChatDeleteMode = "preserve-graph" | "delete-nodes";
/** What one deletion removed from the ledgers (the DELETE response's
 *  stats; the UI can show "3 topics, 2 links removed" from this). */
export interface ChatDeletionStats {
    /** Distinct nodes that died entirely (all their lines). */
    nodesRemoved: number;
    /** Chain assertion LINES removed (empty-provenance or dead member). */
    chainsRemoved: number;
    /** Coverage rows removed. */
    coverageRemoved: number;
    /** Checkpoint lines removed. */
    checkpointsRemoved: number;
}
/**
 * Remove one chat's traces from the graph ledgers. Synchronous by design
 * (the atomicity argument above); idempotent (a second run finds nothing
 * and returns zero stats).
 */
export declare function deleteChatTraces(graphStore: GraphStore, chatId: string, mode: ChatDeleteMode): ChatDeletionStats;
/**
 * FULL DEATH for one node, by id (owner ruling 2026-09-23): the user
 * pointing at the node IS the intent — references from other sessions do
 * NOT preserve it. The remedy for undeletable nodes (preserve-graph
 * orphans from session deletion; notes-import nodes with no chat behind
 * them), and the deliberate inverse of the chat cascade above: that one
 * deletes a SESSION and lets nodes survive on foreign references; this
 * one deletes a NODE and takes its every trace —
 *
 *   - every line of the node (create + link lines)
 *   - every CHAIN referencing it (as premise or conclusion), whatever
 *     session asserted it — a chain with a dead member is not a chain
 *   - its resting position (and every dead chain's)
 *
 * An ARGUMENT deletion is the same call with an arg_-prefixed id (owner,
 * 2026-09-30: the chain table's fenced delete kills chains): the "node"
 * is the derived implication node whose id IS the chain's id.
 *
 * The blast radius is exactly the rows naming the id: other nodes'
 * provenance, aliases, and sessions are untouched (full death is
 * NODE-scoped, not session-scoped), and the source records of notes
 * imports stay (the import's bookkeeping; deleting one proposition is not
 * deleting the file). Derived data needs no pruning: the birth partition
 * derives on read (the cluster shrinks below MIN_CLUSTER_SIZE and stops
 * rendering — fine), and no other consumer indexes nodes by id across
 * ledgers.
 *
 * Synchronous, one rewriteLedgers call, no awaits (the same atomicity
 * argument as the chat cascade); idempotent in the wave-6 sense — a
 * second run finds no lines and changes nothing.
 */
export interface NodeDeletionStats {
    /** Chain assertion LINES removed (every chain referencing the node). */
    chainsRemoved: number;
}
/**
 * Full-death one node (or one argument, by its arg_ id). Returns null
 * when no such node/chain exists (the orchestration maps that to 404);
 * rewrites only the ledgers that changed (unchanged files keep their
 * mtimes — the version stamp moves only when something really did).
 */
export declare function deleteNodeTraces(graphStore: GraphStore, nodeId: string): NodeDeletionStats | null;
//# sourceMappingURL=graph-deletion.d.ts.map