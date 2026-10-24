/**
 * PUT /api/settings/[section] — section-scoped record writes
 * (settings-storage wave, 2026-09-19). One PUT replaces ONE section
 * replace-whole (absent fields = absent overrides — the house settings
 * discipline, same as the per-chat and defaults routes); sections are
 * independent, so partial writes can never clobber each other.
 *
 *   section ∈ general | chat | agent | appearance | graph | compaction
 *   Body: the complete desired section object. Parse + validate strictly
 *   (server/settings-body.ts): a bad shape/type is a 400 carrying the
 *   supported list where one exists. The chat and models sections
 *   additionally pass the catalog gate (validateChatSettings /
 *   validateModelsSettings — unknown provider/model = 400). Thinking
 *   levels never reject a write (owner, interlude 2026-09-22): a pinned
 *   level CLAMPS to the named model's nearest supported level and the
 *   clamped value is stored — model swaps just work, same as the
 *   defaults route. The agent section additionally validates prompt
 *   switches — under the orphan-heal contract (interlude 2026-09-26): an
 *   ON switch with its override file present is valid as-is; an ON whose
 *   file is gone (deleted outside the app, a disk wipe, or a record from
 *   before the delete-clears-switch fix) is an ORPHAN and is healed to
 *   OFF (the key drops) inside the same write — never a 400. Invariant:
 *   a user can never get stuck unable to write settings, and switch
 *   state never contradicts file reality for long (the delete route
 *   clears the switch by construction; this is the backstop).
 *
 * The static siblings (defaults, prompts) take precedence over this
 * dynamic segment — Next resolves static routes first, so "prompts" never
 * lands here.
 */
export declare const dynamic = "force-dynamic";
export declare function PUT(request: Request, ctx: {
    params: Promise<{
        section: string;
    }>;
}): Promise<Response>;
//# sourceMappingURL=route.d.ts.map