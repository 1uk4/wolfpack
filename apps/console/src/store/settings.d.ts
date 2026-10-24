/**
 * Server-side persistence for THE user settings record (settings-storage
 * wave, 2026-09-19): data/settings.json (config.SETTINGS_FILE), under the
 * LH_DATA_DIR seam — read-modify-write, NOT a ledger. Non-secret product
 * preferences only; secrets stay in auth.json / .env.local.
 *
 * This adapter OWNS the lazy migrations:
 *  1. schema-version bumps (CURRENT_SETTINGS_VERSION) slot in here — the
 *     chain is empty today (v1 is the first shape); pure additions never
 *     bump, so an up-to-date file is always a no-op pass-through.
 *    (The legacy default-settings.json fold died with the chat section —
 *     per-session models, owner 2026-09-28.)
 *
 * Everything off disk is sanitized (core/settings.ts) before it reaches a
 * caller; everything written was already validated by the routes
 * (settings-body.ts) and is sanitized here again — the file can never hold
 * a value that would silently shift a knob.
 */
import { type UserSettings } from "../core/settings.ts";
import type { SettingsStore } from "../core/ports.ts";
/** The persisted record, or null when none exists (first boot). Runs the
 *  migration chain on every read — cheap: a no-op file check when current. */
export declare function readSettings(): UserSettings | null;
/** Persist the record (sanitized). Returns what was written. */
export declare function writeSettings(raw: unknown): UserSettings;
/** The typed adapter (core/ports.ts SettingsStore), for the composition root. */
export declare const settingsStore: SettingsStore;
//# sourceMappingURL=settings.d.ts.map