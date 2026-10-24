/**
 * Plan-tree contracts — the session-scoped dependency tree
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/vision.md.
 */
// ─── Plan tree (vision §2 "formal plan tree") ────────────────────────────────
// A session-scoped dependency tree authored by the teacher via plan tools.
// One substrate with the global graph: tree nodes fold into graph nodes.
/** Statuses of a node: the derived view the plan panel should render. */
export function derivedNodeStatus(statuses, nodeId) {
    if (statuses.current === nodeId)
        return "current";
    if (statuses.visited.has(nodeId))
        return "visited";
    return "upcoming";
}
export function derivePlanStatuses(tree, messages) {
    const ids = new Set(tree.nodes.map((n) => n.id));
    const runs = []; // distinct tagged nodes in call order, CONSECUTIVE
    // duplicates collapsed (several checks on one node = one stay on it)
    for (const m of messages) {
        for (const part of m.parts) {
            // Either quizzing tool (quiz/explain) tags position — the mechanic
            // is a settings switch; the fold recognizes both (owner 2026-09-27).
            if (part.type !== "tool-quiz" && part.type !== "tool-explain")
                continue;
            const nodeId = part.input?.nodeId;
            if (typeof nodeId !== "string" || !ids.has(nodeId))
                continue; // untagged/unknown — moves nothing
            if (runs.at(-1) !== nodeId)
                runs.push(nodeId);
        }
    }
    const current = runs.at(-1) ?? null;
    // Visited = been there in an EARLIER stay: everything before the current
    // run. A revisit (a→b→a) puts a in visited AND current — current wins at
    // render (derivedNodeStatus), visited records it has been left before.
    const visited = new Set(runs.slice(0, -1));
    return { current, visited };
}
/** The same derivation over the NATIVE record: quiz CALLS only (any state —
 *  a dangling call still moves position; results feed nothing). */
export function derivePlanStatusesLh(tree, messages) {
    const ids = new Set(tree.nodes.map((n) => n.id));
    const runs = [];
    for (const m of messages) {
        if (m.role !== "assistant")
            continue;
        const content = m.content;
        if (!Array.isArray(content))
            continue;
        for (const block of content) {
            if (block.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain"))
                continue;
            const nodeId = block.arguments?.nodeId;
            if (typeof nodeId !== "string" || !ids.has(nodeId))
                continue;
            if (runs.at(-1) !== nodeId)
                runs.push(nodeId);
        }
    }
    const current = runs.at(-1) ?? null;
    const visited = new Set(runs.slice(0, -1));
    return { current, visited };
}
//# sourceMappingURL=plan.js.map