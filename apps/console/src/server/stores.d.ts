/**
 * THE COMPOSITION ROOT for storage — the single place concrete store
 * adapters are wired. Everything else (core, services, agents) codes against
 * the port types in core/ports.ts and receives instances through this
 * module. Swapping the fs adapter for SQLite later changes exactly this
 * file (and the adapter implementations in src/store/).
 */
import { type EffectiveSettings } from "../core/settings-resolution.ts";
/** The wired adapters. Satisfies core/graph.ts's GraphDeps structurally. */
export declare const stores: {
    chatStore: import("../core/ports.js").ChatStore;
    graphStore: import("../core/ports.js").GraphStore;
    jobStore: import("../core/ports.js").JobStore;
    settingsStore: import("../core/ports.js").SettingsStore;
};
export type Stores = typeof stores;
/**
 * The resolved view of the settings record (core/settings-resolution.ts):
 * every knob concrete over its factory default — EXCEPT MODELS (BYOK all
 * the way down, owner 2026-09-22): no factory pins exist, so unset model
 * slots resolve to null and per-need refusal gates fire downstream. Read
 * fresh on every call — the record is a small file and turns are rare, so
 * no caching layer (stale toggles after a settings PUT would be worse).
 */
export declare function effectiveSettings(): EffectiveSettings;
//# sourceMappingURL=stores.d.ts.map