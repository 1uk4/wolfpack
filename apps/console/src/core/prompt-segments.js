/**
 * The pure prompt-segment grammar (P2 reconciliation, 2026-09-19):
 * segment-path validation + the shared segment types, ZERO fs. Discovery
 * (reading the agent's prompt tree) lives in the agent layer
 * (src/agent/prompt-segments.ts — the canonical loader composeInstructions
 * composes through); the override-file CRUD lives in the store adapter
 * (src/store/prompt-overrides.ts). Both import THIS grammar so the
 * mirror-layout rules are defined exactly once.
 *
 * Path grammar: "system-prompt.md" (the shared base), "shared/<fragment>"
 * (sources v1: fragments composed by BOTH agents), "prober/<fragment>" /
 * "teacher/<fragment>" — where <fragment> is numeric-prefixed + .md
 * (e.g. 20-teaching.md). POSIX-relative, no traversal, no nesting.
 */
/** A prompt fragment: numeric order key + .md (e.g. 20-teaching.md). Nothing else loads. */
export const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;
/** Validate a segment path against the mirror-layout rules (see module
 *  doc). Exported for the routes, which also check membership in the
 *  CURRENT source segment list. */
export function isValidSegmentPath(segmentPath) {
    if (segmentPath === "system-prompt.md")
        return true;
    const m = /^(prober|teacher|practice|shared)\/([\w.-]+\.md)$/.exec(segmentPath);
    if (!m || m[2] === undefined)
        return false;
    return FRAGMENT_RE.test(m[2]);
}
//# sourceMappingURL=prompt-segments.js.map