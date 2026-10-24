import { stripModelValueDebris } from "./value-debris.ts";
/** The stored chains filtered to a selection (chains-primary, owner
 *  2026-09-30): a chain rides along iff its conclusion AND every premise
 *  are selected; a node in no surviving chain is a singleton chain
 *  (premises: []). Premise-only nodes whose chain was excluded are
 *  singletons — the same inclusion law as the pre-chains edge grouping.
 *  Every stored chain keeps its OWN id (arg_…) — two independent
 *  arguments for one conclusion stay distinct. Deterministic: chains
 *  sorted by id, premises sorted. */
export function chainsForSelection(nodes, chains) {
    const selected = new Set(nodes.map((n) => n.id));
    const chained = new Set();
    const included = [];
    for (const chain of chains) {
        if (!selected.has(chain.conclusion))
            continue;
        if (!chain.premises.every((premise) => selected.has(premise)))
            continue;
        included.push({ id: chain.id, premises: [...chain.premises].sort(), conclusion: chain.conclusion });
        chained.add(chain.conclusion);
        for (const premise of chain.premises)
            chained.add(premise);
    }
    for (const node of nodes) {
        if (!chained.has(node.id)) {
            included.push({ id: node.id, premises: [], conclusion: node.id });
        }
    }
    return included.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** A chain as one world-facing line — the propositions' NAMES joined
 *  by the derivation arrow: "Premise one, Premise two → Conclusion"; a
 *  singleton shows its "(no premises)" marker. Pure + browser-safe.
 *  Unknown ids fall back to the raw id (honest, never guessed).
 *  Premises sort by id — the same determinism law as chainsForSelection. */
/** Resolve ONE target string to a canonical proposition id (owner round
 *  9, 2026-10-05 — the mastery-trace contract): id first (exact), then
 *  name (case-insensitive, trimmed — names are presentational handles,
 *  not unique; an ambiguous name resolves to the FIRST node in store
 *  order). Returns null when nothing matches — the caller rejects.
 *  Validation set is the WHOLE graph, not the session's picks: pickless
 *  sessions and future graph-tools poses stay valid. The debris strip
 *  (whitehead, 2026-10-09) heals copy-syntax (`:node-id`, quoted ids)
 *  before matching — targets are membership values like correctAnswer. */
export function resolveTargetId(target, nodes) {
    const t = stripModelValueDebris(target);
    if (t.length === 0)
        return null;
    if (nodes.some((n) => n.id === t))
        return t;
    const lower = t.toLowerCase();
    for (const n of nodes) {
        if (stripModelValueDebris(n.name).toLowerCase() === lower)
            return n.id;
    }
    return null;
}
export function formatChainLine(chain, propositions) {
    const nameOf = (id) => propositions[id]?.name ?? id;
    const premises = [...chain.premises].sort().map(nameOf).join(", ");
    return premises !== ""
        ? `${premises} → ${nameOf(chain.conclusion)}`
        : `${nameOf(chain.conclusion)} (no premises)`;
}
//# sourceMappingURL=chains.js.map