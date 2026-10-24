/**
 * The per-chat model control (model-control wave): replace-whole settings —
 * the picker sends the complete desired object ({} clears all overrides).
 * PER-SESSION MODELS (owner, 2026-09-28): this route is THE in-session
 * writer — the composer's control binds the session's own record; the
 * strong slot is only the birth default and never reaches an existing
 * session again.
 * Validation is the catalog gate (src/server/model-catalog.ts): unknown
 * provider/model is a 400. Thinking levels never reject (owner,
 * interlude 2026-09-22): a pinned level clamps to the named model's
 * nearest supported and the clamped value is stored. Effective next turn
 * by construction (agents are stateless per turn).
 *
 * The body parsing itself is shared with the draft route
 * (src/server/settings-body.ts, default-settings wave 2026-09-18).
 */
export declare function PUT(req: Request, { params }: {
    params: Promise<{
        id: string;
    }>;
}): Promise<Response>;
//# sourceMappingURL=route.d.ts.map