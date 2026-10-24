/**
 * Search rewiring (search port wave, 2026-09-20) — the web_search tool's
 * port injection + the research dispatch tool's registry-level drop.
 *
 * Google CSE is dead: the tool runs on the injected search port
 * (core/search.ts), the runner threads the seam (searchProvider — covered
 * end-to-end in jobs.test.ts), and jobTools drops the research tool when
 * ctx.searchAvailable reports no live engine (owner decision: registry
 * drop, no doomed dispatch, no silent fallback).
 *
 * No network, no shared data files — the jobStore fake below is in-memory.
 */
export {};
//# sourceMappingURL=web-search.test.d.ts.map