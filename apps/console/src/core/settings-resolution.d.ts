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
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ModelRole } from "../../config.ts";
import type { ChatSettings } from "./contracts/chat.ts";
import type { SearchEngineId } from "./search.ts";
import { type BackgroundModelRole, type FactorySettings, type GeneralSettings, type CompactionSettings, type GraphSettings, type ModelSlot, type ModelSlotName, type RoleModelOverride, type UserSettings } from "./settings.ts";
/** A configured model slot: the tier's concrete model, with its optional
 *  thinking level. UNSET level is legal — the engine build resolves it
 *  from config.ts's DEFAULT_THINKING_ORDER (first entry the model
 *  supports; owner, 2026-09-22). A slot is CONFIGURED iff its model is
 *  present; a level-only slot is inert (kept on disk, resolved as null). */
export interface EffectiveSlot {
    provider: string;
    id: string;
    thinkingLevel?: ThinkingLevel;
}
/** A fully-resolved model pin for one role — same shape/level semantics
 *  as EffectiveSlot; undefined means the role's whole chain came up
 *  empty and whatever needs it refuses honestly. */
export interface EffectiveModelSpec {
    provider: string;
    id: string;
    thinkingLevel?: ThinkingLevel;
}
/** The concrete appearance view — same shape as the factory's. */
export type EffectiveAppearance = FactorySettings["appearance"];
/** The concrete view: every knob resolved, no absent fields. */
export interface EffectiveSettings {
    general: Required<GeneralSettings>;
    agent: {
        models: Record<BackgroundModelRole, EffectiveModelSpec | undefined>;
        /** Delta map as stored — consumers resolve absent key → enabled. */
        tools: Record<string, boolean>;
        /** Delta map as stored — absent key → override off. */
        prompts: Record<string, boolean>;
        /** The search-engine preference as stored (search wave, 2026-09-20):
         *  passthrough delta — engine resolution (pin → auto → unavailable)
         *  lives in server/search.ts, where keys are visible. */
        search: {
            engine?: SearchEngineId;
        };
        /** Prober graph tools (wave 7): passthrough delta as stored —
         * absent/undefined enabled = ON; consumers use graphToolsEnabled. */
        graphTools: {
            enabled?: boolean;
        };
    };
    /** The resolved strong/cheap/vision slots: each tier's concrete model or
     *  NULL when the tier holds no model (no factory floor — BYOK all the
     *  way down, owner 2026-09-22). These are the tier-level views the
     *  picker captions and the per-need refusal gates read. */
    models: Record<ModelSlotName, EffectiveSlot | null>;
    appearance: EffectiveAppearance;
    graph: Required<GraphSettings>;
    /** Compaction (owner round 14): resolved concrete — absent record
     *  section resolves to the factory 150k. */
    compaction: Required<CompactionSettings>;
}
/** The conversation pair's chain (BYOK, owner 2026-09-22): the chat's own
 *  model override over the STRONG slot, each field independent (a bare
 *  chat thinking level rides the strong slot's model). null = no model
 *  anywhere — the turn gate refuses with the 503 models_not_configured
 *  envelope. */
export declare function resolveConversationSpec(chat: ChatSettings | undefined, strong: EffectiveSlot | null): EffectiveModelSpec | null;
/** Full-chain resolution for ANY role (BYOK, owner 2026-09-22):
 *  per-role override (background roles only) → SLOT → NOTHING. The
 *  conversation pair (prober/teacher) resolves the same chain MINUS the
 *  role override (their override is the chat's own settings — the
 *  chat-handler overlays it itself). undefined = the chain came up
 *  empty; the per-need refusal gates fire on exactly that. This is the
 *  engine wiring's one call. */
export declare function resolveRoleSpec(role: ModelRole, record: UserSettings | null): EffectiveModelSpec | undefined;
/** Resolve one slot to its configured view, or null when the tier holds
 *  no model (a thinkingLevel-only slot is inert — the level has nothing
 *  to ride without the factory floor). */
export declare function resolveSlot(slot: ModelSlot | undefined): EffectiveSlot | null;
/** Resolve one role's spec — the BYOK chain (owner 2026-09-22): role
 *  override → SLOT → NOTHING, each field independent (an override may
 *  borrow only the slot's model, or only its thinking budget — a level
 *  with no model anywhere stays unset and the engine build resolves it
 *  from DEFAULT_THINKING_ORDER). undefined = no model resolved; the
 *  per-need refusal gates fire on exactly that. */
export declare function resolveModelSpec(role: ModelRole, override: RoleModelOverride | undefined, slots?: Partial<Record<ModelSlotName, ModelSlot>>): EffectiveModelSpec | undefined;
/** Resolve the whole record. `record` may be null (first boot) — every
 *  factory-defaulted field lands on its default; MODEL fields resolve to
 *  null/undefined when unset (no factory pins exist — BYOK all the way
 *  down, owner 2026-09-22). */
export declare function resolveSettings(record: UserSettings | null): EffectiveSettings;
/**
 * The WRITE channel gate (extraction + its auditor): dies with the master
 * switch. Used by the chat-handler's post-turn trigger. (Wave 7: the master
 * switch is the ONLY graph setting left — the section collapsed.)
 */
export declare function extractionEnabled(graph: {
    enabled: boolean;
}): boolean;
/**
 * The RENDERING gate (owner, 2026-10-06): graph off = the home shows the
 * chains view, not the canvas. Display-only by construction — every data
 * path (ledgers, extraction, tools) never consults this.
 */
export declare function renderingEnabled(graph: {
    rendering: boolean;
}): boolean;
/**
 * The PROBER GRAPH TOOLS gate (wave 7, owner ruling 2026-09-23): the
 * toggle is an agent-capability switch (it gates tool registration), but
 * the tools only mean anything when the graph itself runs — so the
 * effective gate composes the graph master switch AND the toggle.
 * Teacher's tool factories consume this at registration time.
 */
export declare function graphToolsEnabled(effective: {
    graph: {
        enabled: boolean;
    };
    agent: {
        graphTools: {
            enabled?: boolean;
        };
    };
}): boolean;
//# sourceMappingURL=settings-resolution.d.ts.map