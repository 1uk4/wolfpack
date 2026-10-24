/**
 * Knowledge-graph contracts — nodes, ledgers, extraction findings
 *
 * The minimal implementation of the graph vision (docs/vision.md §1, the
 * 2026-09-02 redesign): every node is a TRUE proposition; edges are follows
 * (derivable) and supports (grounds without entailing); provenance is
 * message-granular; extraction is free-form and post-hoc, fully decoupled
 * from the session's plan tree. The graph is an extraction of the reasoning
 * chains from all teaching sessions (and imported notes) — NOTHING else:
 * no quiz outcomes, no understanding assessments (2026-09-27 cleanup).
 * Anything not
 * yet decided (the state model, strength derivation, selection strategies) is deliberately NOT here — transitional
 * stubs carry the renderer until those land.
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/vision.md.
 */
// ─── Knowledge graph (vision §1 — global, cross-session) ────────────────────
/** The graph-family format version this build writes and understands
 *  (the format.json sidecar — src/store/graph-format.ts). */
export const CURRENT_GRAPH_FORMAT_VERSION = 1;
/** The auto-title's character cap (owner, 2026-10-06): long enough to
 *  stay informative in the sidebar and the top bar, short enough that a
 *  first message never reads as a paragraph. Tunable — one number, one
 *  place. */
export const TITLE_MAX_CHARS = 72;
/** Derive a short chat title from the learner's first message (pure).
 *  Smart truncation (owner, 2026-10-06): the cut snaps to a word boundary
 *  AT OR UNDER the cap — a title never ends mid-word. The one exception
 *  is a single word longer than the cap (rare, but real: identifiers,
 *  URLs): it cuts at the cap, splitting the word. Whitespace collapses to
 *  single spaces first, so boundaries are always single-space boundaries.
 *  Used on chat creation; deterministic so tests can pin it. */
export function titleFromPrompt(prompt) {
    const oneLine = prompt.replace(/\s+/g, " ").trim();
    if (oneLine.length <= TITLE_MAX_CHARS)
        return oneLine;
    // Last space among the first TITLE_MAX_CHARS characters; the cut sits
    // before it so no trailing space rides into the title.
    let cut = -1;
    for (let i = TITLE_MAX_CHARS; i > 0; i--) {
        if (oneLine[i - 1] === " ") {
            cut = i - 1;
            break;
        }
    }
    // One long word: no boundary exists under the cap — split it (owner's
    // special case). This also lands correctly when the first word exactly
    // fills the cap: cutting at the cap IS the boundary.
    if (cut < 0)
        cut = TITLE_MAX_CHARS;
    return `${oneLine.slice(0, cut)}…`;
}
//# sourceMappingURL=graph.js.map