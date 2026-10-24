/** The 409 extraction_running line (owner phrasing, node interlude):
 *  the server's error names the extraction; the ACTIVITY DOCK is the
 *  surface the user actually watches drain. Exported pure for pins. */
export declare const EXTRACTION_RETRY_LINE = "An extraction is running \u2014 try again when the activity dock drains.";
/**
 * Node deletion (node interlude, Platform's 50bfcba engine) — the
 * confirm surface, portaled z-50 like the session-delete dialog whose
 * tone it follows. FULL DEATH by owner ruling: the node, every edge
 * touching it, every event naming it, its position.
 *
 * MINIMAL BY OWNER RULING (2026-09-30): NO pre-flight impact read —
 * what full death takes is obvious (the edges die with the node), the
 * fetch flickered the dialog open-closed, and richer facts would only
 * grow more confusing as deletion semantics evolve (rewiring talk is
 * on the table). The screen is: title, names, one permanence line,
 * Cancel / Delete. The 409 extraction_running still gets the dock
 * phrasing with a Try-again — the run is never aborted server-side,
 * it clears on its own; other failures state themselves plainly.
 *
 * WORDING: "node"/"nodes" — THE UI word for graph objects (owner
 * ruling, same day, standardized everywhere in the UI).
 */
/** The dialog's pure body — exported for SSR pins (the settings-dialog
 *  body pattern). The wrapper owns state + effects + the portal. */
export declare function DeleteNodeBody({ nodes, busy, failure, onClose, onRun, }: {
    /** One node (the canvas context menu) or many (the chain table's
     *  selection). One names it alone; many pluralize the title and
     *  list the names. */
    nodes: {
        id: string;
        name: string;
    }[];
    busy: boolean;
    failure: {
        code: string;
        error: string;
    } | null;
    onClose: () => void;
    onRun: () => void;
}): any;
export declare function DeleteNodeDialog({ nodes, onClose, onDeleted, }: {
    /** The nodes up for deletion; null/empty = closed. One (the canvas
     *  context menu) or many (the chain table's selection). Names from
     *  the client's snapshot — what the user sees is what the dialog
     *  names. */
    nodes: {
        id: string;
        name: string;
    }[] | null;
    onClose: () => void;
    /** Success path — the callers announce lh:graph-revision so the
     *  snapshot refetches. The deleted ids ride along so
     *  selection-side callers can prune. */
    onDeleted: (nodeIds: string[], graphRevision: number) => void;
}): any;
//# sourceMappingURL=delete-node-dialog.d.ts.map