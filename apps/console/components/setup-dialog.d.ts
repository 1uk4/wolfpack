import type React from "react";
import { type ModelCatalogEntry, type ModelSlotName, type ModelsSettings } from "@/src/core";
import { type ProviderKeyInfo } from "@/components/settings/keys-section";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
/** Pure: which stage the flow opens at — no keyed provider = keys first
 *  (owner's dependency ordering). Exported for tests. */
export declare function setupStage(providers: {
    id: string;
    keyPresent: boolean;
}[] | null): "keys" | "pickers";
/** Prefill (owner, BYOK wave 2026-09-22): each pinned tier opens with its
 *  pick — matched in the FEDERATED catalog (a lapsed key's pin does not
 *  prefill); unpinned tiers stay empty and carry the "needed" mark.
 *  First-run = nothing pinned → all three empty + marked. Exported pure
 *  for tests. */
export declare function prefillFromSlots(models: ModelCatalogEntry[], slots: Record<ModelSlotName, {
    model: {
        provider: string;
        id: string;
    };
} | null> | undefined): Partial<Record<ModelSlotName, ModelCatalogEntry>>;
/** Level prefill (chunk 2): a pinned tier opens with its STORED level
 *  as-is (Save clamps server-side if the ladder lapsed), else the
 *  ordering's level for that model — the level a fresh pick would
 *  populate (owner: the ordering's only purpose is first assignment).
 *  Exported pure for tests. */
export declare function prefillLevelFromPin(entry: ModelCatalogEntry, pin: {
    thinkingLevel?: ThinkingLevel;
} | null | undefined): ThinkingLevel;
/** Stage 1's pure body — exported for SSR pins (the delete/settings
 *  body pattern). The wrapper owns state + effects + the portal.
 *
 * The first-key screen (owner, zero-keys wave): provider picker (the
 * app's shared dropdown language, ProviderMenuList), one paste input,
 * Save. A save that 400s keeps the line inline (the keys section's
 * shape-gates write user-facing error text). */
export declare function SetupKeysBody({ providers, provider, value, saving, error, menuOpen, onToggleMenu, onPick, onValue, onSave, menuAnchor, }: {
    /** The full provider roster (GET /api/keys providers) — undefined
     *  while it loads; the picker renders an honest empty state then. */
    providers: ProviderKeyInfo[] | undefined;
    /** The chosen provider; null = the picker trigger reads "Pick a
     *  provider…". */
    provider: ProviderKeyInfo | null;
    value: string;
    saving: boolean;
    error: string | null;
    menuOpen: boolean;
    onToggleMenu: () => void;
    onPick: (p: ProviderKeyInfo) => void;
    onValue: (v: string) => void;
    onSave: () => void;
    /** The MenuShell anchor — wired by the wrapper (its triggerRef). */
    menuAnchor: React.RefObject<HTMLDivElement | null>;
}): any;
export declare function SetupDialog({ open, onClose, 
/** Saved: the models section landed; the caller marks configured (the
 *  draft stays put — save never sends). */
onDone, }: {
    open: boolean;
    onClose: () => void;
    onDone: (models: ModelsSettings) => void;
}): any;
//# sourceMappingURL=setup-dialog.d.ts.map