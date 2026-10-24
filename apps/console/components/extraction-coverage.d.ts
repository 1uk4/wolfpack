/**
 * The extraction-coverage surfaces (extraction-UX redesign, owner-locked
 * dispatch 2026-09-24): the ring meter in the chat top bar and the coverage
 * block in the sidebar's session context menu — the two replacements for
 * the graph view's coverage panel (components/graph-coverage.tsx, retired
 * with this wave). Coverage is the SAME derivation, scoped to one session:
 * GET /api/chats/[id] now carries `coverage` (Platform's eed4b4e).
 *
 * The ring fills with uncoveredTokens / extractionChunkTokens — the chunk
 * budget the threshold setting (Graph ▸ extractionChunkTokens) pins: the
 * meter is "how close this session is to firing its next extraction run".
 * It DRAINS as a run folds (coverage re-derives per request), pulses while
 * a run is in flight, and vanishes entirely when the graph is off (the
 * master kill-switch means no extraction, so no meter).
 *
 * The manual affordance stays POST /api/graph/coverage/extract {chatId}
 * (409 = already running, BENIGN — the trigger raced us; the dock's
 * start-site nudge seam refreshes either way).
 */
/** Client-safe mirror of the server's SessionCoverage (src/server/chats.ts
 *  — the GET /api/chats/[id] `coverage` block). */
export interface SessionCoverage {
    totalMessages: number;
    coveredCount: number;
    uncoveredCount: number;
    coveredTokens: number;
    uncoveredTokens: number;
    running: boolean;
    lastFoldedAt: string | null;
}
/** The ring's denominator + visibility, resolved through the SAME core
 *  resolver the server's effective settings use (fix, 2026-10-02): the
 *  meter denominates at exactly the number the extraction trigger waits
 *  for — the old hand-rolled `?? 4096` fallback drifted from the factory
 *  default (8192) and the ring filled at half the truth. Null on fetch
 *  failure → no ring. */
export interface GraphRead {
    enabled: boolean;
    chunkTokens: number;
}
/** Exported for the render pin (the ringFill precedent): resolves the
 *  raw settings delta to the factory-true graph section. */
export declare function fetchGraphRead(): Promise<GraphRead | null>;
/**
 * The info block at the bottom of the session context menu (owner-locked
 * redesign): what the extractor hasn't covered yet, plus the manual Extract
 * affordance — visually separated from Rename/Delete below (those stay the
 * two session-management actions). Fetched ON MENU OPEN (the block mounts
 * with the menu — on-demand, never eagerly), polled at 2s while a run is
 * in flight so the numbers settle live. No coverage (fetch failed, 404):
 * the whole block renders nothing — no fake zeros.
 */
export declare function CoverageMenuBlock({ chatId }: {
    chatId: string;
}): any;
/** The block's presentational core (exported for static-render tests):
 *  the numbers, the running pulse, and the Extract affordance with its
 *  optimistic "Running" state. */
export declare function CoverageMenuBody({ coverage, extracting, onExtract, }: {
    coverage: SessionCoverage;
    /** Click-pending (optimistic) until the server says running. */
    extracting: boolean;
    onExtract: () => void;
}): any;
/** The donut's geometry (pure, exported for tests): the fill fraction
 *  uncovered/chunk, clamped to [0,1] — at 1 the next run fires. */
export declare function ringFill(uncoveredTokens: number, chunkTokens: number): number;
/**
 * The ring meter (owner-locked: "a donut next to the PhaseChip"): how
 * close this session is to its next extraction run. Click → the exact
 * numbers (covered/uncovered tokens, messages, the threshold, the last
 * fold). Vanishes entirely while the graph is disabled or before the
 * first successful read. While a run is in flight the ring PULSES (the
 * implementer's visual call per the dispatch — motion is the honest
 * state signal in this app's quiet register; no new chrome).
 *
 * Refresh chains: mount + `refreshKey` (the chat view bumps it at turn
 * settle, riding the existing refetch chains) + a 2s poll while running
 * (resets as the fold drains coverage) + the settings signal (the
 * threshold/kill-switch re-read live).
 */
export declare function CoverageRing({ chatId, refreshKey }: {
    chatId: string;
    refreshKey?: number;
}): any;
/** The donut itself (exported for static-render tests): a hairline track
 *  plus the fill arc — uncovered/chunk of the circumference, starting at
 *  12 o'clock. The whole ring pulses while a run is in flight. */
export declare function CoverageRingGlyph({ fill, running }: {
    fill: number;
    running: boolean;
}): any;
/** The popover body (exported for static-render tests): the exact numbers —
 *  covered/uncovered tokens, message coverage, the threshold, the last
 *  fold's age. */
export declare function CoverageRingDetail({ coverage, chunkTokens }: {
    coverage: SessionCoverage;
    chunkTokens: number;
}): any;
//# sourceMappingURL=extraction-coverage.d.ts.map