/**
 * PUT/DELETE /api/settings/prompts/[...segment] — the override TEXT for
 * one prompt segment (settings-storage wave, 2026-09-19).
 *
 *   PUT    body {text} → writes data/prompts/<segment path mirror>. 200.
 *          The segment must be a CURRENT source segment (allSegmentPaths
 *          — derived from src/agent/prompts at runtime): overriding a
 *          segment that doesn't compose is a typo or a vanished fragment,
 *          a 400, never a silent orphan.
 *   DELETE → removes the override file (idempotent) AND clears the
 *          record's switch for that segment in the same operation
 *          (contract fix, interlude 2026-09-26 — overrules the 2026-09-19
 *          "switch survives a delete/re-write cycle" note). The old
 *          behavior orphaned the on-switch: the write validation then
 *          400'd every agent-section write while the UI's disabled toggle
 *          couldn't reach the OFF escape hatch — a user stuck unable to
 *          write settings. Delete clears the switch so the route and the
 *          record agree BY CONSTRUCTION; the write path additionally heals
 *          any orphan that still arises (disk-level wipes outside the
 *          app's control) — see [section]/route.ts. Order here: clear the
 *          switch first, then unlink — a crash between the two leaves
 *          "off + file", a valid state, never an orphan.
 *
 * The ON/OFF switch itself lives in the record's agent.prompts map
 * (PUT /api/settings/agent) — file presence alone is never the override.
 */
export declare const dynamic = "force-dynamic";
export declare function PUT(request: Request, ctx: {
    params: Promise<{
        segment: string[];
    }>;
}): Promise<Response>;
export declare function DELETE(_request: Request, ctx: {
    params: Promise<{
        segment: string[];
    }>;
}): Promise<Response>;
//# sourceMappingURL=route.d.ts.map