import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
/** Display labels for the levels (shared by every trigger that shows
 *  one). Lowercase, always (owner refinement round, 2026-09-24): the
 *  level strings ARE the display form — the settings menus render them
 *  raw, so the composer pill and setup dialog must match, never Title
 *  Case. */
export declare const THINKING_LABEL: Record<string, string>;
/** The level a fresh pick of `supported` populates with. Empty support
 *  (shouldn't happen — the catalog always reports at least ["off"])
 *  resolves "off", matching the server's fallback. */
export declare function defaultOrderLevel(supported: readonly ThinkingLevel[]): ThinkingLevel;
/** An EXPLICIT level always rides — even when the fresh pick's model
 *  doesn't support it: the WRITE clamps it to the nearest supported level
 *  server-side (Platform's interlude bd68486 — the owner's swap-400 case
 *  now just works), and the cross-surface signal re-reads so the clamped
 *  truth displays. The ordering only assigns FIRST: when no explicit
 *  level exists, a fresh model pick populates the ordering's level for
 *  that model (chunk 2: the unset state can never re-enter). */
export declare function populateLevel(explicit: ThinkingLevel | undefined, supported: readonly ThinkingLevel[]): ThinkingLevel;
//# sourceMappingURL=thinking-default.d.ts.map