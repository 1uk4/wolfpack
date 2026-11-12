/**
 * THE SERVER-SIDE SURFACE — the only src module (besides the core barrel)
 * that app/ may import. Route handlers and server components come through
 * here; nothing under app/ touches src/store or src/agent directly.
 */

export * from "./thread/events-stream.ts";
export * from "./kb/graph-positions.ts";
export * from "./settings/stores.ts";
export { readRenderSettings, writeRenderSettings } from "../store/render-settings.ts";
// The settings record + prompt overrides (settings-storage wave, 2026-09-19).
// The *Record aliases keep the app/api/settings routes explicit about which
// seam they touch (the raw record, not the chat-section convenience view).
export {
	readSettings as readSettingsRecord,
	writeSettings as writeSettingsRecord,
	settingsStore,
} from "../store/settings.ts";

// The auth/keys composition (auth-keys wave, 2026-09-19): the curated
// key catalog + the env-reflecting store behind GET/PUT/DELETE /api/keys.
// Importing this module runs the idempotent boot fill-gap — every consumer
// keeps its plain process.env reads (that seam is the point).
export * from "./settings/keys.ts";
export * from "./settings/settings-body.ts";
export * from "./settings/model-catalog.ts";

// The ConsoleClient seam (client-rewire wave): the factory + the thin
// Response handlers the /api/wolves routes and the wolf pages share.
export * from "./thread/console-client.ts";
export * from "./thread/thread-api.ts";
export * from "./kb/memory-api.ts";
export * from "./kb/kb-activity-api.ts";
export * from "./thread/needs-you-api.ts";
export * from "./pack/devices-api.ts";
export * from "./pack/machines-api.ts";
export * from "./settings/prompts-api.ts";
export * from "./settings/settings-overview-api.ts";
export * from "./settings/wolf-settings-api.ts";
// Pack health (work-wolfpack-LUQ7C2B): probes + restarts that never go through the hub.
export * from "./pack/health-api.ts";
export * from "./pack/pack-health.ts";
export * from "./pack/pack-actions.ts";
export * from "./thread/session-witness.ts";
export * from "./pack/domains-api.ts";
