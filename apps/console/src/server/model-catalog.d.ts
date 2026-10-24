/**
 * The model catalog's server surface (model-control wave, 2026-09-12;
 * federated since the model-slots wave, 2026-09-20): pi-ai's catalog for
 * every KEYED provider, projected to client-safe DTOs for the picker (GET
 * /api/models), plus the validation gate for settings writes (PUT
 * /api/settings/* — the per-chat settings PUT is retired from the UI;
 * legacy records' per-chat overrides still resolve server-side).
 *
 * pi-ai owns ALL the data: the catalog (id/name/cost/context/modality/
 * thinkingLevelMap) and the per-model thinking truth
 * (getSupportedThinkingLevels / clampThinkingLevel). This module only
 * projects and validates — no second registry to drift out of sync.
 *
 * Federation: `getModels()` is called per keyed provider (federated, the
 * model-slots wave), so a provider appears in the picker exactly when its
 * key is present — piModels() in src/agent/models.ts owns the provider
 * set; nothing here changes.
 */
import { type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ChatSettings } from "../core/contracts/chat.ts";
import type { CatalogDefaults, CatalogProvider, ModelCatalogEntry, ModelCatalogResponse, RolePins, SlotPins } from "../core/contracts/models.ts";
import type { EffectiveModelSpec, EffectiveSlot } from "../core/settings-resolution.ts";
import { type BackgroundModelRole, type ModelsSettings } from "../core/settings.ts";
/** The picker's client-safe model entry (contract: core/contracts/models.ts). */
export type ModelDto = ModelCatalogEntry;
/**
 * The conversation agents' resolved default (pure form — the strong slot
 * in, CatalogDefaults out; `catalogDefaults()` below is the fs wrapper).
 * PER-SESSION MODELS (owner, 2026-09-28): every session owns its model +
 * thinking level from birth, stamped verbatim from the strong slot — the
 * STRONG SLOT IS THE NEW-SESSION DEFAULT, and the resolve-time fallback
 * for legacy settings-less records. BYOK (owner, 2026-09-22): there is no
 * factory floor — when the strong slot names no model, the default is
 * NULL and the turn gate refuses with the 503 models_not_configured
 * envelope. An unset thinkingLevel resolves from DEFAULT_THINKING_ORDER at
 * engine build (reported as absent here).
 */
export declare function catalogDefaultsFor(strong: EffectiveSlot | null): CatalogDefaults | null;
/** The conversation agents' resolved default — what a settings-less chat
 *  runs: the strong slot, i.e. the birth-default for new sessions. */
export declare function catalogDefaults(): CatalogDefaults | null;
/** Project the resolved per-role specs to the client DTO (pure — the
 *  settings UI's "Default: <actual pinned model>" caption reads this).
 *  BYOK (owner, 2026-09-22): an empty chain projects to NULL — the caption
 *  honestly shows "not configured", never a phantom default. */
export declare function rolePinsFor(models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>): RolePins;
/** The background roles' RESOLVED pins: the user's agent-models
 *  override → tier slot → nothing — the same resolution the agent wiring
 *  uses (src/server/stores.ts effectiveSettings), so the caption can
 *  never drift from what actually runs. */
export declare function catalogRolePins(): RolePins;
/** The three slot tiers' RESOLVED pins — effectiveSettings().models
 *  verbatim: the same resolution the engine wiring uses, so the Models
 *  settings page's captions cannot drift from what actually runs. NULL
 *  per tier that holds no model. */
export declare function catalogSlots(): SlotPins;
/** The providers surface (model slots wave, 2026-09-20): one row per
 *  plain-key model provider (core/auth-keys.ts's pi-ai-derived table),
 *  with keyPresent read env-wins through the keys seam, fresh per call —
 *  saving a key immediately federates the provider into the picker. */
export declare function catalogProviders(): CatalogProvider[];
/** Project one catalog model to the client DTO. */
export declare function toModelDto(model: Model<Api>): ModelDto;
/** The live-limits index (context-meter amendment, owner 2026-09-23):
 *  provider:id → contextWindow from pi's catalog, over the SAME keyed
 *  providers the picker federates. The one source for every context
 *  meter's denominator — the stats-bar join holds /api/models' copy,
 *  and the activity feed (observability.ts) resolves job limits
 *  server-side through this. No hardcoded fallback exists anywhere:
 *  a model missing here reads limit-null (usage-only, honest render). */
export declare function catalogContextLimits(): Map<string, number>;
/** The full picker payload: every model of every configured provider
 *  (sorted by provider then id — stable, diff-friendly) + the config
 *  defaults a settings-less chat runs + the background roles' resolved
 *  pins (the settings UI's per-role default captions). */
export declare function modelCatalog(): ModelCatalogResponse;
/** One validated outcome for a settings write. */
export type SettingsValidation = {
    ok: true;
} | {
    ok: false;
    error: string;
    supported?: ThinkingLevel[];
};
/** Validate a picker write against the catalog (the settings route's gate).
 *  `settings` is replace-whole: absent fields mean "config default".
 *  - model: provider must be configured, id must exist in its catalog.
 *  - thinkingLevel: must be in the resolved model's supported list —
 *    the model the picker writes against (settings.model, else config's
 *    prober/teacher pin; one controller, so the two specs share it). */
export declare function validateChatSettings(settings: ChatSettings): SettingsValidation;
export declare function validateModelsSettings(settings: ModelsSettings): SettingsValidation;
/** The models-section write's level translation: every slot's pinned
 *  thinkingLevel clamps against THE SLOT'S OWN model (the parser requires
 *  a model on every slot write — owner, 2026-09-22). Pure: catalog in,
 *  clamped section out; the route applies it after validation. */
export declare function clampModelsLevels(settings: ModelsSettings): ModelsSettings;
/** The chat-section write's level translation: a pinned thinkingLevel
 *  clamps against the body's own model, else the record's resolved strong
 *  slot (the conversation chain's fallback — what a settings-less chat
 *  would run). No model anywhere → rides unchecked (runtime clamps at
 *  engine build; the turn gate refuses the model-less chat anyway). */
export declare function clampChatLevel(settings: ChatSettings, strong: EffectiveSlot | null): ChatSettings;
//# sourceMappingURL=model-catalog.d.ts.map