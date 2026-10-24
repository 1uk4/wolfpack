/**
 * The BIRTH STAMP (per-session models, owner ruling 2026-09-28): every
 * session owns its model + thinking level from birth — POST /api/chats
 * stamps the newborn chat verbatim from the settings record's STRONG
 * slot, the new-session default. From then on the strong slot never
 * reaches the session again (in-session picks write the session's own
 * record; resolveConversationSpec prefers chat.settings.model).
 *
 * This pin drives the actual route handler (framework-free
 * Request/Response) under an isolated LH_DATA_DIR — the seam must be set
 * before the first import that transitively loads config.ts, so every
 * app-module import is dynamic (the prompt-overrides discipline).
 */
export {};
//# sourceMappingURL=chat-birth-stamp.test.d.ts.map