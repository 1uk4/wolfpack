/** A node's birth session: its first surviving provenance point's chatId.
 *  null when the node carries no provenance at all (legacy data). */
export function birthSessionOf(node) {
    return node.provenance[0]?.chatId ?? null;
}
/**
 * The birth-session partition over the given node LINES: dedupes by id
 * (first line defines — the getGraph rule), groups by birth session, and
 * returns the groups size-desc with members sorted (deterministic output:
 * ties break by session id ascending). A node with no provenance is left
 * unclustered — it belongs to no session the graph can name.
 */
export function birthSessionPartition(nodes) {
    const members = new Map();
    const seen = new Set();
    for (const node of nodes) {
        if (seen.has(node.id))
            continue;
        seen.add(node.id);
        const birth = birthSessionOf(node);
        if (birth === null)
            continue;
        const bucket = members.get(birth);
        if (bucket)
            bucket.push(node.id);
        else
            members.set(birth, [node.id]);
    }
    return [...members.entries()]
        .map(([id, list]) => ({ id, members: [...list].sort() }))
        .sort((a, b) => b.members.length - a.members.length || (a.id < b.id ? -1 : 1));
}
/** The cluster key a derived implication node takes: MAJORITY among its
 *  PREMISES' birth sessions (owner, 2026-09-30 — premises, NOT the
 *  conclusion), ties to the chain's OWN birth (its provenance's first
 *  point, the asserting session — deterministic, and it coincides with
 *  the unanimous common case anyway). Imp nodes are always re-derived,
 *  never birthed, so their cluster must be a function of the derivation
 *  — this is that function. */
export function impClusterKey(chain, birthOf) {
    const counts = new Map();
    for (const premise of chain.premises) {
        const birth = birthOf(premise);
        if (birth !== null)
            counts.set(birth, (counts.get(birth) ?? 0) + 1);
    }
    const own = chain.provenance[0]?.chatId ?? null;
    if (counts.size === 0)
        return own;
    let max = 0;
    for (const n of counts.values())
        if (n > max)
            max = n;
    const winners = [];
    for (const [key, n] of counts)
        if (n === max)
            winners.push(key);
    if (winners.length === 1)
        return winners[0];
    // Tie → the chain's own birth; if even that is missing, the
    // alphabetically-first winner (last-resort determinism).
    return own ?? winners.sort()[0];
}
/** Attach derived imp nodes to communities IN PLACE (the shared seam for
 *  both consumers of cluster membership — the sim's centroid pull and
 *  the canvas's region rasterization both read members lists that went
 *  through here). Only MULTI-premise fully-live chains mint imp nodes
 *  (single-premise chains collapsed to direct arrows, rendering arc
 *  2026-09-30); dangling chains mint nothing. A chain whose home
 *  community is absent from the list stays unclustered — like its
 *  premises when the hull filter drops them. */
export function attachImpToCommunities(communities, propositions, chains) {
    const birthById = new Map(propositions.map((node) => [node.id, birthSessionOf(node)]));
    const live = new Set(propositions.map((node) => node.id));
    for (const chain of chains) {
        if (chain.premises.length < 2)
            continue;
        if (!live.has(chain.conclusion) || !chain.premises.every((p) => live.has(p)))
            continue;
        const key = impClusterKey(chain, (id) => birthById.get(id) ?? null);
        const community = key === null ? undefined : communities.find((c) => c.id === key);
        if (!community)
            continue;
        community.members.push(chain.id);
    }
    for (const community of communities)
        community.members.sort();
}
//# sourceMappingURL=session-clusters.js.map