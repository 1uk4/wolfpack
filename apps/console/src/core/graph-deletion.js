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
const EMPTY_STATS = {
    nodesRemoved: 0,
    chainsRemoved: 0,
    coverageRemoved: 0,
    checkpointsRemoved: 0,
};
/**
 * Remove one chat's traces from the graph ledgers. Synchronous by design
 * (the atomicity argument above); idempotent (a second run finds nothing
 * and returns zero stats).
 */
export function deleteChatTraces(graphStore, chatId, mode) {
    if (mode !== "preserve-graph" && mode !== "delete-nodes") {
        throw new Error(`Unknown deletion mode: ${mode}`);
    }
    // The bookkeeping rows die in BOTH modes — coverage and checkpoints
    // are extraction state, not graph content (owner semantics: even
    // preserve-graph deletes "the chat's coverage rows").
    const coverage = graphStore.readCoverage().filter((row) => row.chatId !== chatId);
    const checkpoints = graphStore.readCheckpoints().filter((row) => row.chatId !== chatId);
    const stats = {
        ...EMPTY_STATS,
        coverageRemoved: graphStore.readCoverage().length - coverage.length,
        checkpointsRemoved: graphStore.readCheckpoints().length - checkpoints.length,
    };
    if (mode === "preserve-graph") {
        if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
            graphStore.rewriteLedgers({ coverage, checkpoints });
        }
        return stats;
    }
    // ── delete-nodes: the full purge ──────────────────────────────────────
    const nodeLines = graphStore.readNodes();
    const chainLines = graphStore.readChains();
    // Does the chat touch the graph at all? (A never-extracted chat still
    // needs its coverage rows dropped above, but no ledger rewrite — keeps
    // mtimes stable so the graph revision only moves when something really
    // changed.)
    const touched = nodeLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId)) ||
        chainLines.some((line) => line.provenance.some((pt) => pt.chatId === chatId));
    if (!touched) {
        if (stats.coverageRemoved > 0 || stats.checkpointsRemoved > 0) {
            graphStore.rewriteLedgers({ coverage, checkpoints });
        }
        return stats;
    }
    // 1. Survival: a node lives iff a reference from ANY surviving source
    //    remains — another chat/src's provenance point on any of its lines.
    //    (Chain members are deliberately NOT survival references: a
    //    chain's asserting session always left provenance on its endpoints,
    //    so endpoint-only liveness cannot occur in a consistent ledger —
    //    and counting it would keep nodes alive whose lines we would then
    //    drop, dangling the chain.)
    const survives = (points) => points.some((pt) => pt.chatId !== chatId);
    const live = new Set();
    for (const line of nodeLines) {
        if (survives(line.provenance))
            live.add(line.id);
    }
    // 2. Node lines. Per-line (each line is ONE extraction run's append, so
    //    per-session alias provenance exists at line granularity):
    //      dead node            every line dies
    //      untouched line        kept verbatim
    //      partially-deleted     kept with the chat's points stripped
    //                           (defensive — single-run lines never mix chats)
    //      all points deleted    CREATE line: identity survives, aliases
    //                           stripped (owner ruling 2026-09-23), points
    //                           empty / LINK line: dies with its phrasings
    const outNodes = [];
    const seenIds = new Set();
    for (const line of nodeLines) {
        if (!live.has(line.id))
            continue; // the whole node dies
        const first = !seenIds.has(line.id);
        seenIds.add(line.id);
        const points = line.provenance.filter((pt) => pt.chatId !== chatId);
        if (points.length === line.provenance.length) {
            outNodes.push(line); // untouched by this chat
            continue;
        }
        if (points.length > 0) {
            outNodes.push({ ...line, provenance: points });
            continue;
        }
        if (first) {
            // The create line of a surviving node the deleted chat minted:
            // name/statement/createdAt are the shared identity other
            // sessions recognized — they stay; the session's phrasings and
            // provenance die (all traces, owner 2026-09-23).
            outNodes.push({ ...line, provenance: [], aliases: [] });
        }
        // else: the deleted chat's link line — dies with its phrasings.
    }
    // 3. Chains: strip the chat's points; an assertion dies when its
    //    provenance empties or ANY member node (premise or conclusion)
    //    died IN THIS DELETION. (Only nodes that existed and died count —
    //    a chain whose members never resolved as nodes is foreign data the
    //    deletion leaves alone: destructive rewriting may not exceed the
    //    deleted chat's blast radius.)
    const deadNodes = new Set([...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)));
    const outChains = [];
    for (const line of chainLines) {
        if (deadNodes.has(line.conclusion) || line.premises.some((premise) => deadNodes.has(premise)))
            continue;
        const points = line.provenance.filter((pt) => pt.chatId !== chatId);
        // An assertion dies when THIS deletion empties its provenance — a
        // line that already had no points is foreign/legacy data, not this
        // chat's trace; it rides untouched.
        if (line.provenance.length > 0 && points.length === 0)
            continue;
        outChains.push(points.length === line.provenance.length ? line : { ...line, provenance: points });
    }
    stats.nodesRemoved = [...new Set(nodeLines.map((line) => line.id))].filter((id) => !live.has(id)).length;
    stats.chainsRemoved = chainLines.length - outChains.length;
    graphStore.rewriteLedgers({
        nodes: outNodes,
        chains: outChains,
        coverage,
        checkpoints,
    });
    // 4. Positions: prune dead nodes AND dead chains (an argument's derived
    //    implication node carries the chain's arg_ id — stale resting spots
    //    would pin nothing; pruning keeps the ledger honest and the
    //    revision moving for exactly the right reason).
    const deadChainIds = new Set(chainLines
        .filter((line) => !outChains.includes(line))
        .map((line) => line.id));
    const positions = graphStore.readPositions();
    const knownNodeIds = new Set(nodeLines.map((line) => line.id));
    const prunedPositions = Object.fromEntries(Object.entries(positions).filter(([id]) => (live.has(id) || !knownNodeIds.has(id)) && !deadChainIds.has(id)));
    if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
        graphStore.writePositions(prunedPositions);
    }
    return stats;
}
function nodeLinesOf(graphStore, nodeId) {
    return graphStore.readNodes().filter((line) => line.id === nodeId);
}
function chainLinesOf(graphStore, chainId) {
    return graphStore.readChains().filter((line) => line.id === chainId);
}
/**
 * Full-death one node (or one argument, by its arg_ id). Returns null
 * when no such node/chain exists (the orchestration maps that to 404);
 * rewrites only the ledgers that changed (unchanged files keep their
 * mtimes — the version stamp moves only when something really did).
 */
export function deleteNodeTraces(graphStore, nodeId) {
    const chainLines = graphStore.readChains();
    // The argument branch: an arg_ id names a CHAIN, not a proposition —
    // its lines die, and that is the whole death (the member propositions
    // survive: deleting an argument spares its premises/conclusion).
    if (nodeId.startsWith("arg_")) {
        const outChains = chainLines.filter((line) => line.id !== nodeId);
        if (outChains.length === chainLines.length)
            return null; // unknown argument
        graphStore.rewriteLedgers({ chains: outChains });
        const positions = graphStore.readPositions();
        if (positions[nodeId] !== undefined) {
            const { [nodeId]: _dead, ...rest } = positions;
            graphStore.writePositions(rest);
        }
        return { chainsRemoved: chainLines.length - outChains.length };
    }
    const nodeLines = nodeLinesOf(graphStore, nodeId);
    if (nodeLines.length === 0)
        return null;
    const outChains = chainLines.filter((line) => line.conclusion !== nodeId && !line.premises.includes(nodeId));
    // Only the touched ledgers: the node's own lines always die (its file
    // must move), everything else rewrites only when rows actually drop.
    const outNodes = graphStore.readNodes().filter((line) => line.id !== nodeId);
    graphStore.rewriteLedgers({
        nodes: outNodes,
        ...(outChains.length !== chainLines.length ? { chains: outChains } : {}),
    });
    // The resting positions die with the node and every dead chain.
    const deadChainIds = new Set(chainLines.filter((line) => !outChains.includes(line)).map((line) => line.id));
    const positions = graphStore.readPositions();
    const prunedPositions = Object.fromEntries(Object.entries(positions).filter(([id]) => id !== nodeId && !deadChainIds.has(id)));
    if (Object.keys(prunedPositions).length !== Object.keys(positions).length) {
        graphStore.writePositions(prunedPositions);
    }
    return {
        chainsRemoved: chainLines.length - outChains.length,
    };
}
//# sourceMappingURL=graph-deletion.js.map