import { deriveView, getGraph } from "../core/graph.ts";
import { settleGraphLayout } from "../core/layout-settle.ts";
import { stores } from "./stores.ts";
/** Max |x| or |y| accepted — NaN/Infinity clamp here, absurd too. */
const MAX_COORD = 1e6;
/**
 * Accepts the raw PUT body (a Record of id → {x, y}) and returns the
 * sanitized positions actually persisted (empty object = nothing written,
 * e.g. a body with no known ids — the caller reports but never fails).
 */
export function commitPositions(input) {
    if (typeof input !== "object" || input === null)
        return {};
    const raw = input;
    // Only ids the canvas's world actually has: stored propositions plus
    // the DERIVED arg_ implication nodes (deriveView of the current graph
    // — the same derivation the snapshot serves, so ids agree by
    // construction).
    const known = new Set(deriveView(getGraph(stores.graphStore)).nodes.map((n) => n.id));
    const positions = {};
    for (const [id, value] of Object.entries(raw)) {
        if (!known.has(id))
            continue;
        if (typeof value !== "object" || value === null)
            continue;
        const { x, y } = value;
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y))
            continue;
        positions[id] = {
            x: Math.min(Math.max(x, -MAX_COORD), MAX_COORD),
            y: Math.min(Math.max(y, -MAX_COORD), MAX_COORD),
        };
    }
    if (Object.keys(positions).length === 0)
        return {};
    stores.graphStore.writePositions(positions);
    // The graph grew past what the client knew (a merge landed mid-drag):
    // absorb the new nodes with the client's rest state as anchors. The
    // honest test: some node of the CURRENT view is absent from the
    // client's payload — proposition or arg_ alike (the old count
    // comparison broke once args counted as persistable).
    for (const id of known) {
        if (!(id in positions)) {
            settleGraphLayout(stores.graphStore);
            break;
        }
    }
    return positions;
}
//# sourceMappingURL=commit-positions.js.map