export declare function GET(_req: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}): Promise<Response>;
/**
 * Rename (2026-09-17): the header's click-to-edit title commits here.
 * Validation is a single rule — a non-empty string after trim (the store's
 * "Untitled session" floor is never reached from this route). updatedAt is
 * deliberately NOT bumped: a rename must not reorder the sidebar (same
 * rule as the settings PUT).
 */
export declare function PUT(req: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}): Promise<Response>;
/**
 * DELETE /api/chats/[id]?mode=preserve-graph|delete-nodes — session deletion
 * (wave 6, owner rulings 2026-09-22/23). The mode is REQUIRED and explicit:
 * no default, because the two differ in destructiveness —
 *
 *   preserve-graph  the session record, its jobs, and its extraction
 *                   bookkeeping (coverage/checkpoint rows) die; the graph
 *                   keeps every contribution the session merged.
 *   delete-nodes    "this session never happened": every ledger trace of
 *                   the session goes too — provenance, link lines,
 *                   events, mappings — and orphaned nodes die entirely
 *                   (shared nodes survive automatically, their other
 *                   sessions' content intact).
 *
 * Gates are the server orchestration's (server/chats.ts deleteChatSession):
 * 409 while a turn or background job is running, 503 while the session's
 * extraction is winding down after its abort — both retryable. The
 * response carries what was removed plus the new graphRevision (the
 * version stamp the UI polls to refetch clusters/layout).
 */
export declare function DELETE(req: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}): Promise<Response>;
//# sourceMappingURL=route.d.ts.map