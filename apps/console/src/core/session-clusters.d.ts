/**
 * BIRTH-SESSION CLUSTERING (wave 7, owner-locked 2026-09-23): embeddings
 * are dead — a proposition's cluster is the SESSION THAT CREATED IT,
 * derived deterministically from provenance. Cluster labels are session
 * names (the chat title or the imported file's path): no model call, no
 * key, no configuration. What the agglomerative pass grouped by MEANING
 * proximity, this groups by WHERE KNOWLEDGE WAS BORN — the owner's call
 * that the session that minted a set of propositions is the honest
 * "region of the world model" they belong to.
 *
 * Birth session (owner ruling 2026-09-23): a node's FIRST surviving
 * provenance point's chatId — the create line's first point at read time
 * (getGraph merges lines by id, first line defines, provenance unions in
 * line order — so provenance[0] is the birth point of the surviving
 * lines). This makes deletion self-healing with ZERO special handling:
 * delete-nodes strips a session's create lines and its provenance points;
 * a SURVIVING shared node re-attributes to its earliest remaining
 * contributor (provenance[0] walks forward), and a node left with NO
 * provenance at all is simply unclustered. The partition is derived on
 * every read — there is no persisted partition to invalidate.
 *
 * Notes imports are birth-sessions too (owner ruling 2026-09-23): their
 * nodes carry a "src_…" source id instead of a chat id; the caller labels
 * them with the file's path (kind: file in the session views). The old
 * mapping-line fallback for provenance-empty notes nodes is GONE (owner,
 * 2026-09-29): every merge writes provenance points, and the mappings
 * ledger itself died with per-job in-memory resolution — provenance is
 * the one birth record.
 *
 * Browser-safe pure logic (no node builtins, no fs): same contract style
 * as the rest of the core graph derivation. Not re-exported through the
 * core barrel — the shell reads clusters from the snapshot; only the
 * server-side derivations (snapshot, settle) and tests import this.
 */
import type { GraphChain, GraphNode } from "./contracts.ts";
/** One birth-session cluster: the session id + the SORTED member node
 *  ids born in it. The shape is deliberately the { members } contract
 *  the layout consumer takes; `id` rides along for consumers that need
 *  the session identity (the snapshot's cluster id + label join). */
export interface BirthSessionCluster {
    /** The birth session's id — a chatId or a notes source id ("src_…"). */
    id: string;
    /** Node ids born in this session, sorted. */
    members: string[];
}
/** A node's birth session: its first surviving provenance point's chatId.
 *  null when the node carries no provenance at all (legacy data). */
export declare function birthSessionOf(node: Pick<GraphNode, "provenance">): string | null;
/**
 * The birth-session partition over the given node LINES: dedupes by id
 * (first line defines — the getGraph rule), groups by birth session, and
 * returns the groups size-desc with members sorted (deterministic output:
 * ties break by session id ascending). A node with no provenance is left
 * unclustered — it belongs to no session the graph can name.
 */
export declare function birthSessionPartition(nodes: readonly GraphNode[]): BirthSessionCluster[];
/** The cluster key a derived implication node takes: MAJORITY among its
 *  PREMISES' birth sessions (owner, 2026-09-30 — premises, NOT the
 *  conclusion), ties to the chain's OWN birth (its provenance's first
 *  point, the asserting session — deterministic, and it coincides with
 *  the unanimous common case anyway). Imp nodes are always re-derived,
 *  never birthed, so their cluster must be a function of the derivation
 *  — this is that function. */
export declare function impClusterKey(chain: Pick<GraphChain, "premises" | "provenance">, birthOf: (nodeId: string) => string | null): string | null;
/** Attach derived imp nodes to communities IN PLACE (the shared seam for
 *  both consumers of cluster membership — the sim's centroid pull and
 *  the canvas's region rasterization both read members lists that went
 *  through here). Only MULTI-premise fully-live chains mint imp nodes
 *  (single-premise chains collapsed to direct arrows, rendering arc
 *  2026-09-30); dangling chains mint nothing. A chain whose home
 *  community is absent from the list stays unclustered — like its
 *  premises when the hull filter drops them. */
export declare function attachImpToCommunities(communities: Array<{
    id: string;
    members: string[];
}>, propositions: ReadonlyArray<Pick<GraphNode, "id" | "provenance">>, chains: ReadonlyArray<Pick<GraphChain, "id" | "premises" | "conclusion" | "provenance">>): void;
//# sourceMappingURL=session-clusters.d.ts.map