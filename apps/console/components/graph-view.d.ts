import { type GraphCostSummary, type GraphNode, type GraphSnapshot } from "@/src/core";
import { type GraphRenderSettings } from "./graph-canvas.ts";
type RenderSettings = GraphRenderSettings;
/**
 * Pure filter predicate for the search panel: a node is visible when the
 * query is empty or matches its name or statement (case-insensitive).
 * Exported for tests; the visibility feed just consumes its verdict.
 */
export declare function isNodeVisible(node: Pick<GraphNode, "name" | "statement">, query: string): boolean;
/** In-place sessions patch for a live rename (rename-shuffle fix,
 *  2026-09-23). The OLD path built a fresh snapshot object, which
 *  flowed through the [snapshot]-keyed setData effect → geometry
 *  rebuild → last-fetched ledger became authoritative + pending drag
 *  commit cancelled → the graph visibly rewound whenever display had
 *  drifted. This seam NEVER changes object identity: same snapshot
 *  reference, same clusters array — so the data feed cannot re-fire.
 *  The display refresh rides a separate tick state, and the cluster
 *  label itself goes through the renderer's label-only channel
 *  (setClusterLabels). Exported for tests; pure display state only —
 *  the server derives the same join on its next read. */
export declare function renameSessionsPatch(snapshot: Pick<GraphSnapshot, "sessions">, id: string, title: string): void;
/** Seed positions for nodes the ledger doesn't know yet (hygiene,
 *  2026-09-23 fix wave): they used to fall through to a ?? 0 and dump
 *  at the origin. Place them on a deterministic ring around the known
 *  positions' centroid — angle hashed from the id (FNV-1a), golden-angle
 *  spiral offset so even hash collisions spread. Stable across
 *  remounts, far enough off the mass to see, and they relax with the
 *  pack on the next drag. In-place on the provided map; pure otherwise. */
export declare function seedMissingNodePositions(nodes: readonly {
    id: string;
}[], positions: Map<string, {
    x: number;
    y: number;
}>): Map<string, {
    x: number;
    y: number;
}>;
/**
 * The cost figures the UI DISPLAYS (owner refinement round, 2026-09-24):
 * extraction + audit only. Cluster naming is dead — labels are session
 * titles / file names — so the core's naming fold (and its historical
 * spend) is deliberately not shown anywhere: the pill and the panel must
 * agree, and both read THIS, never GraphCostSummary.totalDollars.
 * (The core fold's naming stage was then culled outright — 2026-09-24 —
 * so the recent-runs list carries extraction runs only.)
 */
export declare function displayCostTotals(costs: Pick<GraphCostSummary, "stages">): {
    totalDollars: number;
    unpricedRuns: number;
};
/**
 * The graph-pipeline cost control (2026-09-20 placement wave): a bare
 * cumulative-dollars number — no pill chrome (owner: "just a number"),
 * hover-highlighted, click toggles the breakdown panel. Same dismiss
 * pattern as the settings gear: outside click or Escape closes. The
 * panel is viewport-capped + scrollable like the coverage dropdown.
 */
/** Exported for the chains home (graph rendering off, owner
 * 2026-10-06): the same bare cumulative-dollars pill + panel. */
export declare function GraphCostControl({ costs }: {
    costs: GraphCostSummary;
}): any;
/** The top-chrome actions row's body (empty-graph chrome wave, owner
 *  2026-09-25): Import Notes renders ALWAYS (graph enabled) — it's the
 *  one action that works on an empty graph, the entry point itself;
 *  search + settings render only when the snapshot has nodes (dead
 *  controls are lies — the honesty principle). The two gated controls
 *  fade in on their mount (graph-chrome-fade-in, globals.css — the
 *  appear-once transition as the first nodes land). Exported pure for
 *  the empty/populated SSR pins (the DeleteNodeBody pattern). */
export declare function GraphChromeRow({ isEmpty, query, onQuery, noMatch, importing, searchInputRef, fileInputRef, onImportFiles, settings, changeSettings, onOpenChains, }: {
    isEmpty: boolean;
    query: string;
    onQuery: (v: string) => void;
    /** The search panel's "No matching nodes." note (computed by the
     *  wrapper — it owns visibleIds + the snapshot). */
    noMatch: boolean;
    importing: boolean;
    searchInputRef: React.RefObject<HTMLInputElement | null>;
    fileInputRef: React.RefObject<HTMLInputElement | null>;
    onImportFiles: (files: FileList | null) => void;
    settings: GraphRenderSettings;
    changeSettings: (update: (cur: RenderSettings) => RenderSettings) => void;
    /** Opens the chain table overlay (the chains-overlay plan,
     *  2026-09-29). */
    onOpenChains: () => void;
}): any;
export declare function GraphView({ chainSelectOpen, practiceSelection, onPracticeSelectionChange, onChainSelectClose, }: {
    /** PRACTICE SELECT (owner vision, 2026-10-04): the LIFTED, persistent
     *  pick set — every check/clear in the chain table (however opened)
     *  reports the full node list up immediately; the composer-side chip
     *  reflects it live. chainSelectOpen still drives the picker mode
     *  (Done instead of Delete). */
    chainSelectOpen?: boolean;
    practiceSelection?: ReadonlySet<string>;
    onPracticeSelectionChange?: (nodes: {
        id: string;
        name: string;
        statement: string;
    }[]) => void;
    onChainSelectClose?: () => void;
}): any;
export {};
//# sourceMappingURL=graph-view.d.ts.map