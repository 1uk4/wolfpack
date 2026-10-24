/**
 * The shared settings-PUT body parsers — one seam per settings surface.
 * Extracted verbatim from the per-chat route (default-settings wave,
 * 2026-09-18): identical parse, identical errors. The section parsers
 * (settings-storage wave, 2026-09-19) follow the same house rules.
 *
 * Replace-whole semantics: the client sends the complete desired SECTION;
 * absent fields are absent overrides ({} clears everything). No merges, so
 * a stale client can never resurrect a cleared override. Unknown body keys
 * are dropped (same tolerance as parseSettingsBody) — unknown DISK keys are
 * a different concern and are preserved by the sanitizer (core/settings.ts).
 */
import { type ChatSettings } from "../core";
import type { AgentSettings, AppearanceSettings, CompactionSettings, GeneralSettings, GraphSettings, ModelsSettings } from "../core/settings.ts";
/** Parsed-or-rejected — `ok: false` carries the 400's error message. */
export type SettingsBodyResult<T> = {
    ok: true;
    settings: T;
} | {
    ok: false;
    error: string;
};
export declare function parseSettingsBody(body: unknown): SettingsBodyResult<ChatSettings>;
/** general: { autoUpdate?: boolean } */
export declare function parseGeneralSettingsBody(body: unknown): SettingsBodyResult<GeneralSettings>;
/** agent: { models?, tools?, prompts? } — model/thinking validity against
 *  the catalog is checked by the route (validateChatSettings discipline);
 *  prompt switch-on membership is checked by the route (needs the store). */
export declare function parseAgentSettingsBody(body: unknown): SettingsBodyResult<AgentSettings>;
/** appearance: { mode?, background?, fontFamily?, proseFontSize?,
 *  sessionNameSerif?, mdRendering? } */
export declare function parseAppearanceSettingsBody(body: unknown): SettingsBodyResult<AppearanceSettings>;
/** graph: the collapsed section { enabled? } (wave 7, owner ruling
 *  2026-09-23): the master switch ONLY — the embedding/clustering/labeling
 *  rungs and the BYOK embeddingModel died with the provider embedder
 *  (clustering is the free birth-session partition, labels are session
 *  names). Old-shape keys in a body are ignored, not rejected. */
export declare function parseGraphSettingsBody(body: unknown): SettingsBodyResult<GraphSettings>;
/** models: { strong?, cheap?, vision? } — the slot tiers (model slots
 *  wave, 2026-09-20). Each slot is the same shape as a role override; a
 *  present-but-empty slot object is rejected (absent slot = unset; say
 *  what you mean). Catalog validity is checked by the route
 *  (validateChatSettings discipline). */
export declare function parseModelsSettingsBody(body: unknown): SettingsBodyResult<ModelsSettings>;
/** compaction (owner round 14): the context-compaction threshold — the
 *  projected-token budget over which a session summarizes its own history
 *  into the compaction marker. Strict write side: a present
 *  thresholdTokens must be a number at or above the floor (the floor is
 *  anti-churn: each compaction keeps a ~20k-token recent tail, so a
 *  smaller threshold would re-summarize the tail it just wrote). Absent =
 *  factory default 150k at resolution. Replace-whole, like every
 *  section. */
export declare function parseCompactionSettingsBody(body: unknown): SettingsBodyResult<CompactionSettings>;
/** The section→parser map for PUT /api/settings/[section] (the route also
 *  carries the special prompts sub-resource). */
export declare const SETTINGS_SECTIONS: {
    readonly general: typeof parseGeneralSettingsBody;
    readonly chat: typeof parseSettingsBody;
    readonly agent: typeof parseAgentSettingsBody;
    readonly appearance: typeof parseAppearanceSettingsBody;
    readonly graph: typeof parseGraphSettingsBody;
    readonly compaction: typeof parseCompactionSettingsBody;
    readonly models: typeof parseModelsSettingsBody;
};
export type SettingsSectionName = keyof typeof SETTINGS_SECTIONS;
//# sourceMappingURL=settings-body.d.ts.map