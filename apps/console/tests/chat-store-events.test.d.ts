/**
 * CHAT STORE EVENT PINS (push-architecture S6, 2026-10-02): the sidebar's
 * 2.5s poll died — list truth now rides chats-changed. The store's law:
 * list-SHAPE writes (create/rename/delete) announce post-write; content
 * writes (messages/usage/settings/tree) are DELIBERATELY silent — the
 * silence law is pinned here so it reads as law, not oversight. Runs
 * under an isolated LH_DATA_DIR (the chat-birth-stamp discipline: the
 * seam is set before any config-loading import, so every app-module
 * import is dynamic).
 */
export {};
//# sourceMappingURL=chat-store-events.test.d.ts.map