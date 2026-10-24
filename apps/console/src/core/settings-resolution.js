/**
 * THE SETTINGS RESOLUTION LAYER (settings-storage wave, 2026-09-19): pure
 * projection of the delta record (core/settings.ts UserSettings) into
 * EffectiveSettings — every field CONCRETE, ready for consumers with no
 * delta-walking of their own.
 *
 * Resolution rule (owner decision): explicit value in the record wins;
 * absent key resolves to the compiled factory default — EXCEPT MODELS
 * (BYOK all the way down, owner 2026-09-22): no factory pins exist, so a
 * model chain that ends empty resolves to null/undefined and whatever
 * needs it refuses honestly (503 models_not_configured). This module
 * stays browser-safe/pure, so it imports config TYPES only, never the
 * runtime module (config.ts pulls node:path).
 *
 * Deliberately NOT resolved here (see settings.ts module doc):
 * - per-chat overrides: the chat record's ChatSettings applies via the
 *   conversation chain in chat-handler (chat.model → strong slot) — prober
 *   and teacher stay chat-controlled, never settings-record-controlled;
 * - tool toggles: passed through as the delta map; consumers look up by
 *   tool id with absent → enabled (the honoring lives in the agent band);
 * - prompt switches: passed through; effective composition lives in
 *   src/store/prompt-overrides.ts (segment list derived from source).
 */
import { BACKGROUND_MODEL_ROLES, FACTORY_SETTINGS, ROLE_SLOT, } from "./settings.ts";
/** The conversation pair's chain (BYOK, owner 2026-09-22): the chat's own
 *  model override over the STRONG slot, each field independent (a bare
 *  chat thinking level rides the strong slot's model). null = no model
 *  anywhere — the turn gate refuses with the 503 models_not_configured
 *  envelope. */
export function resolveConversationSpec(chat, strong) {
    const model = chat?.model ?? (strong ? { provider: strong.provider, id: strong.id } : undefined);
    if (!model)
        return null;
    return {
        provider: model.provider,
        id: model.id,
        thinkingLevel: chat?.thinkingLevel ?? strong?.thinkingLevel,
    };
}
/** Full-chain resolution for ANY role (BYOK, owner 2026-09-22):
 *  per-role override (background roles only) → SLOT → NOTHING. The
 *  conversation pair (prober/teacher) resolves the same chain MINUS the
 *  role override (their override is the chat's own settings — the
 *  chat-handler overlays it itself). undefined = the chain came up
 *  empty; the per-need refusal gates fire on exactly that. This is the
 *  engine wiring's one call. */
export function resolveRoleSpec(role, record) {
    const bg = BACKGROUND_MODEL_ROLES;
    const override = bg.includes(role) ? record?.agent?.models?.[role] : undefined;
    return resolveModelSpec(role, override, record?.models);
}
/** Resolve one slot to its configured view, or null when the tier holds
 *  no model (a thinkingLevel-only slot is inert — the level has nothing
 *  to ride without the factory floor). */
export function resolveSlot(slot) {
    if (!slot?.model)
        return null;
    return { provider: slot.model.provider, id: slot.model.id, thinkingLevel: slot.thinkingLevel };
}
/** Resolve one role's spec — the BYOK chain (owner 2026-09-22): role
 *  override → SLOT → NOTHING, each field independent (an override may
 *  borrow only the slot's model, or only its thinking budget — a level
 *  with no model anywhere stays unset and the engine build resolves it
 *  from DEFAULT_THINKING_ORDER). undefined = no model resolved; the
 *  per-need refusal gates fire on exactly that. */
export function resolveModelSpec(role, override, slots) {
    const slotName = ROLE_SLOT[role];
    const slot = slotName ? slots?.[slotName] : undefined;
    const model = override?.model ?? slot?.model;
    if (!model)
        return undefined;
    return {
        provider: model.provider,
        id: model.id,
        thinkingLevel: override?.thinkingLevel ?? slot?.thinkingLevel,
    };
}
/** Resolve the whole record. `record` may be null (first boot) — every
 *  factory-defaulted field lands on its default; MODEL fields resolve to
 *  null/undefined when unset (no factory pins exist — BYOK all the way
 *  down, owner 2026-09-22). */
export function resolveSettings(record) {
    const agent = record?.agent ?? {};
    const modelsSection = record?.models ?? {};
    const appearance = record?.appearance ?? {};
    const md = appearance.mdRendering ?? {};
    const graph = record?.graph ?? {};
    const factoryAppearance = FACTORY_SETTINGS.appearance;
    const factoryMd = factoryAppearance.mdRendering;
    const models = {};
    for (const role of BACKGROUND_MODEL_ROLES) {
        models[role] = resolveModelSpec(role, agent.models?.[role], modelsSection);
    }
    return {
        general: {
            autoUpdate: record?.general?.autoUpdate ?? FACTORY_SETTINGS.general.autoUpdate,
        },
        agent: {
            models,
            tools: agent.tools ?? {},
            prompts: agent.prompts ?? {},
            search: agent.search ?? {},
            graphTools: agent.graphTools ?? {},
        },
        models: {
            strong: resolveSlot(modelsSection.strong),
            cheap: resolveSlot(modelsSection.cheap),
            vision: resolveSlot(modelsSection.vision),
        },
        appearance: {
            mode: appearance.mode ?? factoryAppearance.mode,
            background: appearance.background ?? factoryAppearance.background,
            fontFamily: appearance.fontFamily ?? factoryAppearance.fontFamily,
            proseFontSize: appearance.proseFontSize ?? factoryAppearance.proseFontSize,
            sessionNameSerif: appearance.sessionNameSerif ?? factoryAppearance.sessionNameSerif,
            mdRendering: {
                headingWeight: md.headingWeight ?? factoryMd.headingWeight,
                boldColor: md.boldColor ?? factoryMd.boldColor,
                italicColor: md.italicColor ?? factoryMd.italicColor,
            },
        },
        graph: {
            // Wave 7 collapse (owner ruling 2026-09-23): the master switch ONLY —
            // the embedding/clustering/labeling rungs and the BYOK embeddingModel
            // are gone (stale record keys are simply never read here).
            enabled: graph.enabled ?? FACTORY_SETTINGS.graph.enabled,
            // The RENDERING switch (owner, 2026-10-06): display-only — gates
            // the home's main view (canvas vs chains), never the data.
            rendering: graph.rendering ?? FACTORY_SETTINGS.graph.rendering,
            // The chunk budget (extraction-UX redesign, 2026-09-24): absent
            // (pre-redesign record, fresh install) resolves to the factory
            // 4096; the sanitizer has already clamped/floored any stored value.
            extractionChunkTokens: graph.extractionChunkTokens ?? FACTORY_SETTINGS.graph.extractionChunkTokens,
        },
        compaction: {
            thresholdTokens: record?.compaction?.thresholdTokens ?? FACTORY_SETTINGS.compaction.thresholdTokens,
        },
    };
}
// ─── Graph channel gates (the settings wave's seam honoring) ─────────────────
/**
 * The WRITE channel gate (extraction + its auditor): dies with the master
 * switch. Used by the chat-handler's post-turn trigger. (Wave 7: the master
 * switch is the ONLY graph setting left — the section collapsed.)
 */
export function extractionEnabled(graph) {
    return graph.enabled;
}
/**
 * The RENDERING gate (owner, 2026-10-06): graph off = the home shows the
 * chains view, not the canvas. Display-only by construction — every data
 * path (ledgers, extraction, tools) never consults this.
 */
export function renderingEnabled(graph) {
    return graph.rendering;
}
/**
 * The PROBER GRAPH TOOLS gate (wave 7, owner ruling 2026-09-23): the
 * toggle is an agent-capability switch (it gates tool registration), but
 * the tools only mean anything when the graph itself runs — so the
 * effective gate composes the graph master switch AND the toggle.
 * Teacher's tool factories consume this at registration time.
 */
export function graphToolsEnabled(effective) {
    return effective.graph.enabled && (effective.agent.graphTools.enabled ?? true);
}
//# sourceMappingURL=settings-resolution.js.map