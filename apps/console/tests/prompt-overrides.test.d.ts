/**
 * Tests for the prompt-override store (settings-storage wave, 2026-09-19):
 * src/store/prompt-overrides.ts — override file CRUD, the mirror-layout
 * path discipline (traversal guard), and the SOURCE-DERIVED segment list
 * (the loader mirrors teacher-agent.ts's composeInstructions discovery;
 * these tests pin that the mirror tracks the real src/agent/prompts tree).
 *
 * TEST-DIR ISOLATION (contract fix, interlude 2026-09-26): data/prompts
 * holds REAL user override files — this suite must never touch it (the
 * old after() wiped it as "disposable scratch", killing real overrides
 * and orphaning their ON switches). LH_DATA_DIR is the established
 * data-location seam (Electron contract, 2026-09-17; see
 * data-dir-seam.test.ts), evaluated at config.ts's MODULE LOAD — so it
 * must be set before the first import that (transitively) loads config.
 * Every app-module import below is dynamic for exactly that reason;
 * only node builtins and config-independent libs stay static. The seam
 * pins at the bottom assert the redirection, and after() snapshots that
 * the REAL repo data/prompts survived the suite untouched.
 *
 * This file OWNS the temp dir (parallel-test discipline: one fs owner
 * per file) — every override-writing test lives here, including the
 * route-level contract pins for the same interlude (delete-clears-switch,
 * orphaned-ON-heals-to-OFF).
 */
export {};
//# sourceMappingURL=prompt-overrides.test.d.ts.map