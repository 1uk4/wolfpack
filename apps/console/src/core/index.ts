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

export * from "./contracts.ts";
export * from "./ports.ts";
export * from "./render-settings.ts";

export * from "./question-core.ts";
// The event bus (push architecture, 2026-10-02): vocabulary + emit/subscribe
// for every layer; the browser shell consumes the types + the runtime names
// through this barrel (shell law: pure core via @/src/core only).
export * from "./events.ts";
export * from "./layout.ts";
export * from "./pending.ts";
export * from "./prompt-segments.ts";
export * from "./math-delims.ts";
// Wave B (owner-approved 2026-09-26): the native record (LhMessage),
// compaction and the input-events contract — all pure logic, browser-safe.
export * from "./native-messages.ts";
export * from "./compaction.ts";
export * from "./input-events.ts";
// Wave D (owner-approved 2026-09-26): the client view model — the grouping
// canon (one continuous assistant document, step separators) ported from
// the deleted server projection to the client side. Pure, browser-safe.
export * from "./view.ts";
export * from "./tool-parts.ts";
export * from "./prices.ts";
export * from "./fuzzy.ts";
// settings.ts + settings-resolution.ts (settings-storage wave, 2026-09-19):
// the user-settings record's shape/sanitizer (pure) and its fully-resolved
// view. Browser-safe — the Wave-4 panel imports these directly.
export * from "./settings.ts";
export * from "./settings-resolution.ts";
export * from "./session-find.ts";
export * from "./session-navigation.ts";
// auth-keys.ts (auth-keys wave, 2026-09-19): the curated key catalog +
// shape rules + masking — pure, browser-safe (the auth page binds to the
// /api/keys routes built on it).
export * from "./auth-keys.ts";
// keyboard.ts: the shortcut registry + binding normalization (pure, browser-safe).
export * from "./keyboard.ts";
// session-markdown.ts: the ONE session→markdown formatter (the export).
// Pure, browser-safe.
export * from "./session-markdown.ts";
// thread-adapter.ts: the ConsoleClient (@wolfpack/client) ↔ session-model
// seam — ThreadEvent → wire events, ThreadMessage → native record. Pure.
export * from "./thread-adapter.ts";
export * from "./tool-rows.ts";
export * from "./kb.ts";
export * from "./graph-activity.ts";
// The KB graph (graph home): the librarian's graph payload → canvas data,
// domain colours, node styles, cards; and the console's own persistence
// rules (positions, camera). Pure, browser-safe.
export * from "./kb-graph-model.ts";
export * from "./graph-persistence.ts";
export * from "./pipeline-model.ts";
export * from "./entry-view.ts";
export * from "./work-view.ts";
export * from "./memory-panel-model.ts";
