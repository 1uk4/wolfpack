import type { GraphChain, GraphNode } from "@/src/core";
/** The sortable columns (owner ruling: all three — consistency). */
export type ChainSortCol = "name" | "props" | "created";
export interface ChainSort {
    col: ChainSortCol;
    /** 1 = ascending (A→Z, oldest-first, smallest-first), -1 = descending. */
    dir: 1 | -1;
}
/** The table's pure body — exported for SSR pins (the render-suite
 *  discipline). All state (query, sort, selection, expansion) arrives
 *  via props; the overlay wrapper below owns it. */
export declare function ChainTableBody({ nodes, chains: storedChains, sessions, fileSources, query, onQuery, sort, onSort, selection, expandedClusters, expandedChains, onToggleCluster, onToggleChain, onToggleNodes, onClear, onDelete, onClose, selectMode, onSelect, }: {
    nodes: GraphNode[];
    chains: GraphChain[];
    sessions: Record<string, string>;
    fileSources: Record<string, string>;
    query: string;
    onQuery: (v: string) => void;
    sort: ChainSort;
    onSort: (col: ChainSortCol) => void;
    selection: ReadonlySet<string>;
    expandedClusters: ReadonlySet<string>;
    expandedChains: ReadonlySet<string>;
    onToggleCluster: (key: string) => void;
    onToggleChain: (id: string) => void;
    /** Selection is ALWAYS a flat node-id set — cluster, chain, and single
     *  proposition checks all reduce to this. */
    onToggleNodes: (ids: string[], next: boolean) => void;
    onClear: () => void;
    /** Opens the full-death confirm dialog (owner, 2026-09-29 night). */
    onDelete: () => void;
    onClose: () => void;
    /** PRACTICE SELECT (2026-10-04): the floating bar's confirm becomes
     *  "Practice these" — no delete fence; the caller owns what the
     *  selection becomes. */
    selectMode?: boolean;
    onSelect?: () => void;
}): any;
/** The graph view's overlay wrapper: owns query + sort + selection +
 *  expansion; mounts ABSOLUTE INSIDE the
 *  graph area, full-bleed (owner ruling: the translucent blurred surface
 *  IS the overlay — no inner card). Esc + the top-bar X dismiss (there
 *  is no backdrop margin to click anymore). Read-only toward the graph. */
export declare function ChainTableOverlay({ open, nodes, chains: storedChains, sessions, fileSources, onClose, 
/** PRACTICE SELECT (owner vision, 2026-10-04): the selection is
 *  PERSISTENT and caller-owned — when these props are present the
 *  table is CONTROLLED (every check/clear/delete-prune reports up
 *  immediately; the composer-side chip reflects it live). selectMode
 *  only changes the floating bar: Done instead of the delete fence
 *  (deleting while picking is a footgun). */
selectMode, controlledSelection, onSelectionChange, }: {
    open: boolean;
    nodes: GraphNode[];
    chains: GraphChain[];
    sessions: Record<string, string>;
    fileSources: Record<string, string>;
    onClose: () => void;
    selectMode?: boolean;
    controlledSelection?: ReadonlySet<string>;
    onSelectionChange?: (next: ReadonlySet<string>) => void;
}): any;
//# sourceMappingURL=chain-table.d.ts.map