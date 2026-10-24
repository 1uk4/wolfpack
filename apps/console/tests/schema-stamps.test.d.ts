/**
 * SCHEMA STAMPS (schema-versioning wave, owner 2026-10-10): LAZY v1 for
 * chats (record.version, stamped at the write choke point) and the graph
 * family (data/graph/format.json sidecar — ledgers, sources,
 * render-settings; positions deliberately unversioned, rebuildable).
 * Honest refusal: records stamped NEWER than this build are refused on
 * read (the downgrade scenario) — never misparsed, never rewritten.
 *
 * Runs under an isolated LH_DATA_DIR (the chat-birth-stamp discipline:
 * the seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */
export {};
//# sourceMappingURL=schema-stamps.test.d.ts.map