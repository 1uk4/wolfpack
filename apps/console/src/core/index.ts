/**
 * THE CORE PUBLIC API — the only module the shell (app/, components/) may
 * import. Everything exported here is browser-safe: pure logic + types,
 * no node builtins, no fs, no network.
 *
 * Server-side surfaces (chat streaming, store reads) live behind
 * src/server's barrel instead — the import law (eslint.config.mjs):
 *
 *   components/**  →  "@/src/core"        (this barrel, ONLY)
 *   app/**         →  "@/src/core" + "@/src/server"
 *
 * The storage PORT TYPES are types-only and browser-safe, hence re-exported.
 */

// Must stay the first import: copies the pre-rename localStorage keys before any read.
export * from "./contracts.ts";
export * from "./ui/ports.ts";
export * from "./graph/render-settings.ts";
export * from "./ui/mobile-layout.ts";

export * from "./thread/question-core.ts";
// The event bus (push architecture, 2026-10-02): vocabulary + emit/subscribe
// for every layer; the browser shell consumes the types + the runtime names
// through this barrel (shell law: pure core via @/src/core only).
export * from "./thread/events.ts";
export * from "./graph/layout.ts";
export * from "./graph/route-layout.ts";
export * from "./thread/pending.ts";
export * from "./thread/math-delims.ts";
export * from "./ui/escape-html.ts";
// Wave B (owner-approved 2026-09-26): the native record (LhMessage),
// compaction and the input-events contract — all pure logic, browser-safe.
export * from "./thread/native-messages.ts";
export * from "./thread/compaction.ts";
export * from "./thread/input-events.ts";
// Wave D (owner-approved 2026-09-26): the client view model — the grouping
// canon (one continuous assistant document, step separators) ported from
// the deleted server projection to the client side. Pure, browser-safe.
export * from "./thread/view.ts";
export * from "./thread/tool-parts.ts";
export * from "./settings/prices.ts";
export * from "./ui/fuzzy.ts";
export * from "./thread/subagents.ts";
export * from "./ui/palette.ts";
// settings.ts + settings-resolution.ts (settings-storage wave, 2026-09-19):
// the user-settings record's shape/sanitizer (pure) and its fully-resolved
// view. Browser-safe — the Wave-4 panel imports these directly.
export * from "./settings/settings.ts";
export * from "./settings/settings-resolution.ts";
export * from "./thread/session-find.ts";
export * from "./thread/session-navigation.ts";
// auth-keys.ts: the model-provider key table (provider id → env var) — pure, browser-safe.
export * from "./settings/auth-keys.ts";
// keyboard.ts: the shortcut registry + binding normalization (pure, browser-safe).
export * from "./ui/keyboard.ts";
// Pure, browser-safe.
// thread-adapter.ts: the ConsoleClient (@wolfpack/client) ↔ session-model
// seam — ThreadEvent → wire events, ThreadMessage → native record. Pure.
export * from "./thread/thread-adapter.ts";
export * from "./thread/objects.ts";
// needs-you.ts: the cross-wolf pending-card list + the notification trigger logic. Pure.
export * from "./thread/needs-you.ts";
export * from "./thread/reply-notify.ts";

// chat-bar.ts: the floating chat bar's attached-thread model + switcher list. Pure.
export * from "./thread/chat-bar.ts";
export * from "./graph/graph-layout.ts";
export * from "./thread/thread-cards.ts";
export * from "./thread/tool-rows.ts";
export * from "./kb/kb.ts";
export * from "./graph/graph-activity.ts";
// The KB graph (graph home): the librarian's graph payload → canvas data,
// domain colours, node styles, cards; and the console's own persistence
// rules (positions, camera). Pure, browser-safe.
export * from "./graph/kb-graph-model.ts";
export * from "./graph/graph-persistence.ts";
export * from "./graph/graph-pane.ts";
export * from "./kb/kb-activity-model.ts";
export * from "./kb/entry-view.ts";
export * from "./work/work-view.ts";
export * from "./kb/item-document.ts";
export * from "./kb/memory-panel-model.ts";
export * from "./ui/panel-host.ts";
export * from "./work/task-graph.ts";
export * from "./work/task-graph-layout.ts";
export * from "./work/feature-progress.ts";
export { coalescedRefresh } from "./ui/coalesced-refresh.ts";
export * from "./thread/thread-lists.ts";
export * from "./thread/thread-color.ts";
export * from "./work/work-table.ts";
export * from "./kb/graduate.ts";
export * from "./work/work-select.ts";
export * from "./work/work-connectors.ts";
export * from "./graph/branch-graph.ts";
export { graphKey, newestRequest } from "./graph/graph-fetch.ts";
export * from "./work/work-id-link.ts";
export * from "./settings/wolf-settings-form.ts";
// pack-sections.ts: the Pack panel sections, badges and entry summary. Pure.
export * from "./pack/pack-sections.ts";
export type { Tone, HealthLink, HealthSnapshotView, InventoryRowView, InventoryState } from "./pack/pack-health-view.ts";
export { ageText, BACK_MS, packSummary } from "./pack/pack-health-view.ts";
export { groupByHost } from "./pack/pack-hosts.ts";
export type { HostInfo, HostCard } from "./pack/pack-hosts.ts";
export { createHealthConnection } from "./pack/pack-health-connection.ts";
export type { HealthConnectionDeps } from "./pack/pack-health-connection.ts";
// machine-card.ts: the Machines section's card rules. Pure.
export * from "./pack/machine-card.ts";
export * from "./pack/pack-devices.ts";
// machine-commands.ts: the browser client for the hub command channel (Machines and Keys sections).
export * from "./pack/machine-commands.ts";
export * from "./pack/keys-model.ts";
export * from "./pack/keys-seal.ts";
export * from "./pack/wolves-model.ts";
export * from "./pack/wolf-prompt-scopes.ts";
export { buildGraphs, type FlowRow, type PromptGraph } from "./settings/prompt-flows.ts";
export { updateWarnings, updateFinished, updateOffered, updateOutcome, updateQuestion } from "./pack/pack-health-view.ts";
export type { HealthActionsView, UpdateUnitView } from "./pack/pack-health-view.ts";
