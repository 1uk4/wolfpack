/**
 * Scripted integration test — the full teacher loop with zero tokens:
 *
 *   learner opens chat → faux model calls `quiz` → server streams + persists
 *   → client grades and sends the ANSWER EVENT back
 *   → faux model reacts → transcript persisted.
 *
 * Drives handleChatRequest directly (plain Request/Response — no Next server
 * needed) with a scripted pi engine (pi-ai's faux provider, docs/
 * pi-engine-swap.md §7). Wave B: POSTs carry ONE INPUT EVENT (never a client
 * transcript), the record is pi-native agent history (read through the
 * projection where a part shape is pinned), and the answer arrives as the
 * question call's real tool result (fork 1, owner 2026-09-26).
 */
export {};
//# sourceMappingURL=chat-flow.test.d.ts.map