/**
 * THE USER SETTINGS RECORD's shape + sanitizer (settings-storage wave,
 * 2026-09-19): one versioned, DELTA-shaped record at the data-dir seam
 * (config.SETTINGS_FILE) holding every non-secret product preference.
 *
 * DELTA SEMANTICS (owner decision, 2026-09-19): the record stores EXPLICIT
 * user choices only — ABSENT keys resolve to the factory defaults compiled
 * into this module (FACTORY_SETTINGS). MODELS are the exception (owner,
 * 2026-09-22 — BYOK all the way down): no factory pins exist, so an absent
 * model key resolves to EMPTY and the per-need gates refuse honestly. A
 * software update that ADDS a knob (new
 * tool, new role, new appearance field) therefore needs no migration: old
 * records simply lack the new keys. `version` is a PRIVATE schema counter
 * for BREAKING shape changes only (field renamed / meaning changed) —
 * unrelated to the app release version. Migrations live in the adapter
 * (src/store/settings.ts), not here.
 *
 * Sanitizer contract (mirrors render-settings.ts discipline): whatever
 * arrives from disk or the network passes through sanitizeUserSettings
 * before use — never trusted raw. Strict on known fields, PRESERVES
 * unknown keys verbatim (a newer record must never be destroyed by an
 * older app reading it). Invalid known values degrade gracefully:
 * out-of-range numbers CLAMP, wrong-typed/invalid fields DROP (resolve to
 * factory default), never throw.
 *
 * Browser-safe: pure logic + types only, no node imports. The resolved
 * (fully concrete) view lives in settings-resolution.ts.
 */
import { AUTH_PROVIDER_KEYS } from "./auth-keys.ts";
/** The schema version this code understands. Bump ONLY for breaking shape
 *  changes (a field renamed/meaning changed); pure additions never bump. */
export const CURRENT_SETTINGS_VERSION = 1;
/** The background-agent roles whose models the Agent settings expose.
 *  The conversation pair (prober/teacher) stays out — chat-controlled via
 *  the strong slot (one controller, the model picker). Tests pin the set. */
export const BACKGROUND_MODEL_ROLES = [
    "researcher",
    "demoBuilder",
    "visualMaker",
    "extractor",
    "auditor",
];
// ─── Model slots (model slots wave, 2026-09-20) ──────────────────────────────
/** The capability tiers a user can pin models into (owner-settled mapping):
 *  strong = prober + teacher (also the per-session default-teacher
 *  starting point); cheap = researcher, demo-builder, extractor, auditor,
; vision = visual-maker + pdf-reader. Resolution per role:
 *  ROLE OVERRIDE → slot → factory pin. */
export const MODEL_SLOTS = ["strong", "cheap", "vision"];
/** The DEFAULT thinking level for UNSET levels only (owner, 2026-09-22):
 *  a slot/override/chat that names a model but no thinking level resolves
 *  to the FIRST entry in this order that the model supports
 *  (getSupportedThinkingLevels); a non-reasoning model resolves "off"
 *  regardless (pi reports exactly ["off"]). EXPLICITLY set levels never
 *  consult this list — they clamp nearest via pi's native
 *  clampThinkingLevel on model switches.
 *
 *  Client surface (interlude, 2026-09-22): this constant lives in the CORE
 *  BARREL — the UI imports it to auto-populate a thinking level on a FRESH
 *  model pick (one source of truth, AUTH_KEYS precedent; per-model
 *  supportedLevels already reach the client via the catalog). The ordering
 *  has NO other client role: legacy unset records keep the runtime
 *  defaultThinkingLevel fallback at engine build. */
export const DEFAULT_THINKING_ORDER = [
    "medium",
    "low",
    "high",
    "minimal",
    "xhigh",
    "max",
];
/** The machine-readable NOT-CONFIGURED refusal envelope (owner, 2026-09-22):
 *  every per-need gate — the turn gate in chat-handler, a job spawn, a
 *  notes import — refuses with this exact shape. HTTP callers get 503 +
 *  this JSON; in-band consumers (the job record's error field) carry the
 *  human `error` line. `missing` names the slot TIER(S) the refused
 *  action needs and found unset. */
export const MODELS_NOT_CONFIGURED_CODE = "models_not_configured";
export function modelsNotConfigured(missing) {
    return {
        error: "No model configured — set up your models first",
        code: MODELS_NOT_CONFIGURED_CODE,
        missing,
    };
}
/** The refusal error text (BYOK, 2026-09-22): job/turn surfaces compose the
 *  record wording around this prefix; UI consumers detect refused work by
 *  it (info tone, not scary-error) — the envelope's home module owns the
 *  string so the writer and the matcher can never drift. */
export function isModelsRefusal(error) {
    return !!error && error.startsWith(modelsNotConfigured([]).error);
}
/** The typed throw for in-process seams (extraction pipeline): callers
 *  catch it to skip honestly (trigger) or surface the 503 envelope
 *  (routes) instead of logging a failure. */
export class ModelsNotConfiguredError extends Error {
    envelope;
    constructor(missing) {
        super(modelsNotConfigured(missing).error);
        this.name = "ModelsNotConfiguredError";
        this.envelope = modelsNotConfigured(missing);
    }
}
/** The key-presence refusal (provider-key interlude, owner, 2026-09-25):
 * a PINNED model is not enough — its provider's key must be present, or
 * the action dies mid-stream masked to a generic error. Same envelope
 * family as modelsNotConfigured: HTTP callers get 503 + this JSON;
 * in-band consumers (the job record's error field) carry the human
 * `error` line. `provider` names whose key is gone; `slots` names the
 * slot tier(s) the refused action resolves to that provider. */
export const PROVIDER_KEY_MISSING_CODE = "provider_key_missing";
/** The refusal wording's invariant tail — the matcher below keys on it
 * (the label prefix varies by provider). */
const PROVIDER_KEY_MISSING_TAIL = "key is set — add one in Settings → Keys";
export function providerKeyMissing(provider, slots) {
    const label = AUTH_PROVIDER_KEYS.find((p) => p.id === provider)?.label ?? provider;
    return {
        error: `No ${label} ${PROVIDER_KEY_MISSING_TAIL}`,
        code: PROVIDER_KEY_MISSING_CODE,
        provider,
        slots,
    };
}
/** The refusal error text (same discipline as isModelsRefusal): UI
 * consumers detect key-refused work by the wording (info tone, not
 * scary-error) — the envelope's home module owns the string so the
 * writer and the matcher can never drift. */
export function isProviderKeyRefusal(error) {
    return !!error && error.endsWith(PROVIDER_KEY_MISSING_TAIL);
}
/** The typed throw for in-process seams (extraction pipeline) — the
 * ProviderKeyMissing sibling of ModelsNotConfiguredError: callers catch
 * it to skip honestly (trigger) or surface the 503 envelope (routes). */
export class ProviderKeyMissingError extends Error {
    envelope;
    constructor(provider, slots) {
        const envelope = providerKeyMissing(provider, slots);
        super(envelope.error);
        this.name = "ProviderKeyMissingError";
        this.envelope = envelope;
    }
}
/** First-run gate (model-slots wave, owner 2026-09-20): the app refuses
 *  to start chats until the user has actively picked all three slots —
 *  there ARE no defaults for 33 providers; a configured app is one whose
 *  models section carries a model in every slot. Thinking levels stay
 *  optional (absent = the resolved tier's budget). */
export function slotsConfigured(models) {
    return Boolean(models?.strong?.model && models?.cheap?.model && models?.vision?.model);
}
/** Which slot a role draws from (model slots wave, 2026-09-20). Includes the
 *  conversation pair and pdfReader (not BackgroundModelRoles — the slot
 *  tier spans every role; only background roles surface per-role overrides). */
export const ROLE_SLOT = {
    prober: "strong",
    teacher: "strong",
    researcher: "cheap",
    demoBuilder: "cheap",
    extractor: "cheap",
    auditor: "cheap",
    visualMaker: "vision",
    pdfReader: "vision",
};
export const FACTORY_SETTINGS = {
    version: CURRENT_SETTINGS_VERSION,
    general: { autoUpdate: true },
    appearance: {
        mode: "dark",
        background: null, // the dark default (#141414) lives in the mode's derivation curve
        fontFamily: null, // Source Sans 3
        proseFontSize: 16,
        sessionNameSerif: true,
        mdRendering: { headingWeight: 900, boldColor: null, italicColor: null },
    },
    graph: { enabled: true, rendering: true, extractionChunkTokens: 4096 },
    compaction: { thresholdTokens: 150_000 },
};
/** The chunk budget's validated floor (GraphSettings.extractionChunkTokens
 *  — see its doc for the penny-batch rationale; the settings PUT names this
 *  in its rejection, the sanitizer clamps to it). */
export const EXTRACTION_CHUNK_TOKENS_FLOOR = 500;
// ─── Sanitizer ─────────────────────────────────────────────────────────────
const PROSE_FONT_MIN = 12;
const PROSE_FONT_MAX = 24;
const clamp = (v, min, max) => Math.min(Math.max(v, min), max);
/** #rgb / #rrggbb (case-insensitive) — the only color format we accept. */
export function isHexColor(value) {
    return /^#[0-9a-fA-F]{3}$/.test(value) || /^#[0-9a-fA-F]{6}$/.test(value);
}
/** Coerce an arbitrary hex-or-null field: null and valid hex pass through,
 *  anything else becomes null (the factory/per-mode default). */
function sanitizeHexOrNull(value) {
    if (value === null)
        return null;
    if (typeof value === "string" && isHexColor(value))
        return value;
    return null;
}
const boolOrDrop = (value) => typeof value === "boolean" ? value : undefined;
function sanitizeGeneral(raw) {
    const out = {};
    const autoUpdate = boolOrDrop(raw.autoUpdate);
    if (autoUpdate !== undefined)
        out.autoUpdate = autoUpdate;
    return out;
}
const THINKING_LEVELS = [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
];
function sanitizeRoleOverride(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const r = raw;
    const out = {};
    if (typeof r.model === "object" &&
        r.model !== null &&
        !Array.isArray(r.model) &&
        typeof r.model.provider === "string" &&
        typeof r.model.id === "string") {
        out.model = {
            provider: r.model.provider,
            id: r.model.id,
        };
    }
    if (typeof r.thinkingLevel === "string" && THINKING_LEVELS.includes(r.thinkingLevel)) {
        out.thinkingLevel = r.thinkingLevel;
    }
    return Object.keys(out).length ? out : undefined;
}
/** The models section (model slots wave, 2026-09-20): each slot keeps
 *  only well-formed parts — the same shape rules as a role override, so a
 *  stale client can't park junk in a slot. */
function sanitizeModels(raw) {
    const out = {};
    for (const slot of MODEL_SLOTS) {
        const cleaned = sanitizeRoleOverride(raw[slot]);
        if (cleaned)
            out[slot] = cleaned;
    }
    return out;
}
function sanitizeBooleanMap(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "boolean")
            out[key] = value;
    }
    return Object.keys(out).length ? out : undefined;
}
function sanitizeAgent(raw) {
    const out = {};
    if (raw.models !== null && typeof raw.models === "object" && !Array.isArray(raw.models)) {
        const models = {};
        for (const [role, override] of Object.entries(raw.models)) {
            if (BACKGROUND_MODEL_ROLES.includes(role)) {
                const cleaned = sanitizeRoleOverride(override);
                if (cleaned)
                    models[role] = cleaned;
            }
        }
        if (Object.keys(models).length)
            out.models = models;
    }
    const tools = sanitizeBooleanMap(raw.tools);
    if (tools)
        out.tools = tools;
    const prompts = sanitizeBooleanMap(raw.prompts);
    if (prompts)
        out.prompts = prompts;
    // Search preference: lenient read side (an unknown engine id drops;
    // the write side's parser is strict — a stale client can't brick the
    // record, it just loses the pin and auto-detection resumes).
    if (raw.search !== null && typeof raw.search === "object" && !Array.isArray(raw.search)) {
        const engine = raw.search.engine;
        if (engine === "tavily" || engine === "brave")
            out.search = { engine };
    }
    // Prober graph tools (wave 7): its own agent-section subsection —
    // lenient read side (a bad shape drops the key and the default ON
    // resumes; the write side's parser is strict).
    if (raw.graphTools !== null && typeof raw.graphTools === "object" && !Array.isArray(raw.graphTools)) {
        const enabled = raw.graphTools.enabled;
        if (enabled === undefined)
            out.graphTools = {};
        else if (typeof enabled === "boolean")
            out.graphTools = { enabled };
    }
    return out;
}
function sanitizeMdRendering(raw) {
    const out = {};
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return out;
    const r = raw;
    if (typeof r.headingWeight === "number" && Number.isFinite(r.headingWeight)) {
        out.headingWeight = clamp(Math.round(r.headingWeight), 100, 900);
    }
    if (r.boldColor !== undefined)
        out.boldColor = sanitizeHexOrNull(r.boldColor);
    if (r.italicColor !== undefined)
        out.italicColor = sanitizeHexOrNull(r.italicColor);
    return out;
}
function sanitizeAppearance(raw) {
    const out = {};
    if (raw.mode === "dark" || raw.mode === "light")
        out.mode = raw.mode;
    if (raw.background !== undefined)
        out.background = sanitizeHexOrNull(raw.background);
    if (raw.fontFamily !== undefined) {
        out.fontFamily = typeof raw.fontFamily === "string" && raw.fontFamily.trim() ? raw.fontFamily : null;
    }
    if (typeof raw.proseFontSize === "number" && Number.isFinite(raw.proseFontSize)) {
        out.proseFontSize = clamp(Math.round(raw.proseFontSize), PROSE_FONT_MIN, PROSE_FONT_MAX);
    }
    const sessionNameSerif = boolOrDrop(raw.sessionNameSerif);
    if (sessionNameSerif !== undefined)
        out.sessionNameSerif = sessionNameSerif;
    if (raw.mdRendering !== undefined)
        out.mdRendering = sanitizeMdRendering(raw.mdRendering);
    return out;
}
function sanitizeGraph(raw) {
    // Wave 7 collapse (owner ruling 2026-09-23): the section is the master
    // switch ONLY. The dead rungs' keys (embedding/clustering/labeling/
    // embeddingModel) in existing records are simply UNREAD and DROPPED by
    // this reconstruction — the migration story: the next graph-section
    // write (PUT is replace-whole) persists the collapsed shape, and no
    // active code ever looks at the stale fields.
    //
    // extractionChunkTokens (extraction-UX redesign, 2026-09-24): the chunk
    // budget — clamp-never-reject (the bd68486 discipline): a finite
    // positive number floors to EXTRACTION_CHUNK_TOKENS_FLOOR (fractions
    // floor to integers), anything else drops to the factory default at
    // resolution. A disk record below the floor (older app, hand edit)
    // clamps UP — the floor is a cost protection, not data to honor.
    const out = {};
    const enabled = boolOrDrop(raw.enabled);
    if (enabled !== undefined)
        out.enabled = enabled;
    const rendering = boolOrDrop(raw.rendering);
    if (rendering !== undefined)
        out.rendering = rendering;
    const rawTokens = raw.extractionChunkTokens;
    if (typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0) {
        out.extractionChunkTokens = Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.floor(rawTokens));
    }
    return out;
}
/** clamp-never-reject (the sanitizer's discipline): a finite positive
 *  number floors to COMPACTION_THRESHOLD_FLOOR, anything else drops (the
 *  factory default resolves at read time). Exported for the PUT parser's
 *  reject-with-rationale (the graph chunk-budget precedent). */
export const COMPACTION_THRESHOLD_FLOOR = 32_000;
function sanitizeCompaction(raw) {
    const out = {};
    const rawTokens = raw.thresholdTokens;
    if (typeof rawTokens === "number" && Number.isFinite(rawTokens) && rawTokens > 0) {
        out.thresholdTokens = Math.max(COMPACTION_THRESHOLD_FLOOR, Math.floor(rawTokens));
    }
    return out;
}
/**
 * Coerce arbitrary JSON (disk file, network body) into a valid delta record:
 * known fields validated strictly (invalid ones drop/clamp per module doc),
 * UNKNOWN KEYS PRESERVED VERBATIM (a newer record must survive an older
 * app). Never throws. Non-objects → null.
 */
export function sanitizeUserSettings(raw) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const r = raw;
    const out = {
        version: typeof r.version === "number" && Number.isInteger(r.version) && r.version >= 1 ? r.version : CURRENT_SETTINGS_VERSION,
    };
    if (r.general !== null && typeof r.general === "object" && !Array.isArray(r.general)) {
        out.general = sanitizeGeneral(r.general);
    }
    if (r.agent !== null && typeof r.agent === "object" && !Array.isArray(r.agent)) {
        out.agent = sanitizeAgent(r.agent);
    }
    if (r.appearance !== null && typeof r.appearance === "object" && !Array.isArray(r.appearance)) {
        out.appearance = sanitizeAppearance(r.appearance);
    }
    if (r.models !== null && typeof r.models === "object" && !Array.isArray(r.models)) {
        const models = sanitizeModels(r.models);
        if (Object.keys(models).length)
            out.models = models;
    }
    if (r.graph !== null && typeof r.graph === "object" && !Array.isArray(r.graph)) {
        out.graph = sanitizeGraph(r.graph);
        if (r.compaction !== undefined && r.compaction !== null && typeof r.compaction === "object") {
            out.compaction = sanitizeCompaction(r.compaction);
        }
    }
    // Unknown top-level keys ride along untouched (forward-compat). One
    // known-DEAD key is stripped instead of riding: `chat` (the old
    // default-settings section) died with per-session models (owner,
    // 2026-09-28) — a fossil copy on disk must never resurrect through
    // reads (and any later write flushes it from the file for good).
    for (const [key, value] of Object.entries(r)) {
        if (key === "chat")
            continue;
        if (!(key in out))
            out[key] = value;
    }
    return out;
}
//# sourceMappingURL=settings.js.map