import { clampThinkingLevel, createModels, getSupportedThinkingLevels, } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
    userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
    attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});
let collection;
/** The process-wide pi-ai Models collection — EVERY builtin provider's
 *  catalog (model slots wave, 2026-09-20): engines and the picker resolve
 *  against all of pi-ai's per-provider catalogs, so a settings slot can pin
 *  any native model id. Auth is resolved per request by pi-ai itself from
 *  the environment (the keys seam reflects file-saved keys into env), and
 *  a provider with no key simply fails its stream with "not configured" —
 *  honest, late, and unreachable through the picker, which gates on
 *  keyPresent. */
export function piModels() {
    if (!collection) {
        collection = createModels({ identity: APP_IDENTITY });
        for (const provider of builtinProviders())
            collection.setProvider(provider);
    }
    return collection;
}
/** OpenRouter API key (BYOK); tests never read this — they inject engines. */
export function openRouterApiKey() {
    return process.env.OPENROUTER_API_KEY || undefined;
}
/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model) {
    const supported = getSupportedThinkingLevels(model);
    for (const level of DEFAULT_THINKING_ORDER) {
        if (supported.includes(level))
            return level;
    }
    return supported[0] ?? "off";
}
/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved by pi-ai itself from the environment per request (the
 *  keys seam reflects file-saved keys into env), so the engine never
 *  hardcodes OpenRouter's. */
export function piEngineForSpec(spec) {
    const models = piModels();
    const model = models.getModel(spec.provider, spec.id);
    if (!model) {
        throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
    }
    // UNSET level → the baked default order (first entry the model
    // supports); SET level → pi's native nearest-clamp (model swaps keep
    // the user's intent and adapt honestly).
    const level = spec.thinkingLevel
        ? clampThinkingLevel(model, spec.thinkingLevel)
        : defaultThinkingLevel(model);
    return {
        model,
        level,
        // bound streamSimple: the agent loop forwards state.thinkingLevel as
        // `reasoning` (undefined = off on pi-ai's scale); the clamp above keeps
        // the pin honest even when config or settings drift off the map.
        streamFn: (requestModel, context, options) => models.streamSimple(requestModel, context, {
            ...options,
            reasoning: level === "off" ? undefined : level,
        }),
    };
}
/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role) {
    throw new Error(`no configured model for role "${role}" — set your model slots (settings → models)`);
}
//# sourceMappingURL=models.js.map