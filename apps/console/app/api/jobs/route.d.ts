export declare const dynamic = "force-dynamic";
/**
 * Job status endpoint (contracts.ts "THE ASYNC PROTOCOL" §4): the chat
 * view's jobs fetch lands here — once on mount, per jobs-changed
 * announcement (the store emits post-write, debounced client-side), and
 * on channel resync (push-architecture S4, 2026-10-02 — the old interval
 * poll is retired). It drives the dispatch cards, the sub-agents panel,
 * and the re-sync when a job settles. `turnInFlight` rides along for the
 * settle logic's idle check.
 */
export declare function GET(req: Request): Promise<Response>;
//# sourceMappingURL=route.d.ts.map