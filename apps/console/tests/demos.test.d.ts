/**
 * Demo + visual artifact tests (W6) — deterministic, zero network, no real
 * Chrome:
 *
 *   1. bridge-script injection (buildDemoSrcDoc) + the pure bridge-message
 *      reducer (reduceDemoBridgeState)
 *   2. card rendering (static markup): sandboxed iframe attrs, error chip,
 *      failure notes, inline sanitized svg
 *   3. the demo-builder loop with a FAKE model + FAKE headless (success with
 *      a fix iteration, untested-final verification, never-clean failure,
 *      no-Chrome failure)
 *   4. the visual-maker loop (fake model + fake headless): render-and-look
 *      success, forced look on premature finish, never-writes failure
 *   5. job runners + dispatch (demo part → demo job → steer via a fake
 *      deliver; visual failure path; end-to-end dispatch through
 *      handleChatRequest with the ack protocol)
 *   6. tool registry wiring (server-executed dispatch tools, schemas)
 *
 * Cleanup follows tests/jobs.test.ts idioms (created chat/job files removed
 * in the after() hook; overrides reset in finally blocks).
 */
export {};
//# sourceMappingURL=demos.test.d.ts.map