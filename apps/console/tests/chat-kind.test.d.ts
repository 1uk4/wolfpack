/**
 * SESSION-KIND PINS (practice sessions, owner 2026-10-04): ChatRecord.kind
 * is ABSENT-BY-DEFAULT — absence reads as teach, so pre-practice records
 * never migrate; "practice" marks an adaptive-practice session (the
 * practice agent + its two tools from turn 1, no extraction, no graph
 * writes). The store normalizes at the summary projection; createChat
 * stamps the marker only for practice. Runs under an isolated LH_DATA_DIR
 * (the chat-birth-stamp discipline: the seam is set before any
 * config-loading import, so every app-module import is dynamic).
 */
export {};
//# sourceMappingURL=chat-kind.test.d.ts.map