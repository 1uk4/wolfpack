import type { ModelCatalogResponse } from "@/src/core";
export declare function useModelCatalog(): {
    catalog: ModelCatalogResponse | undefined;
    refresh: () => void;
};
/** provider:id → contextWindow over the cached catalog — the client-side
 *  twin of the server's catalogContextLimits join (context-meter
 *  amendment, owner 2026-09-23: pi's live catalog is the ONLY limit
 *  source — no hardcoded fallback exists anywhere, so a model missing
 *  from the index reads limit-null and the meter renders usage-only,
 *  the honest-render precedent). Consumed by the stats bar: the same
 *  cached /api/models fetch the picker rides feeds the denominator. */
export declare function catalogLimits(catalog: Pick<ModelCatalogResponse, "models">): Map<string, number>;
/**
 * THE CONVERSATION MODEL CONTROL — dual-bound (owner, per-session models,
 * 2026-09-28). WITH a chatId (the in-session stats bar): the pills bind
 * THE SESSION'S OWN record — reads GET /api/chats/:id (its settings field;
 * a legacy unstamped record falls back to the strong slot's display,
 * exactly what the engine resolves), writes PUT /api/chats/:id/settings
 * (validated + level-clamped server-side). The session owns its model +
 * thinking level from birth; the strong slot never reaches it again.
 *
 * WITHOUT a chatId (the draft surfaces — home + /chat/new): the pills
 * bind the STRONG SLOT (reads the raw models section, GET /api/settings;
 * writes PUT /api/settings/models via composeSlotModel — the same seam
 * the settings Agent section and the SetupDialog write): picking there IS
 * changing the new-session default. Unpicked reads "—" (the
 * no-factory-fallback language: the UI never presents a default model).
 */
export declare function ModelControl({ chatId }: {
    chatId?: string;
}): any;
//# sourceMappingURL=model-picker.d.ts.map