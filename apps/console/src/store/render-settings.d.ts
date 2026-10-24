/**
 * Server-side persistence for the graph render settings (the settings-panel
 * controls): data/render-settings.json — read-modify-write, NOT a ledger.
 *
 * The shape, defaults, and sanitizer live in src/core/render-settings.ts
 * (pure, shared with the client); this module only moves bytes. Whatever
 * comes off disk is sanitized by the caller on load — and we sanitize on
 * write too, so the file can never hold an out-of-range value that would
 * silently shift a slider.
 */
import { DEFAULT_RENDER_SETTINGS, type GraphRenderSettings } from "../core/render-settings.ts";
/** The persisted settings, or null when no file exists yet (first boot). */
export declare function readRenderSettings(): GraphRenderSettings | null;
/** Persist settings (sanitized). Returns what was written. */
export declare function writeRenderSettings(raw: unknown): GraphRenderSettings;
export { DEFAULT_RENDER_SETTINGS };
//# sourceMappingURL=render-settings.d.ts.map