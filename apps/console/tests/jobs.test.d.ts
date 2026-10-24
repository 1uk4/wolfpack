/**
 * Job infrastructure tests — deterministic, zero network:
 *
 *   1. job store CRUD (create → get → update → list → dedup by toolCallId)
 *   2. steer helpers (pure, contracts.ts): buildSubagentSteer shape per kind,
 *      isSubagentFailure, steerDelivered
 *   3. dispatch (async protocol §2): drive handleChatRequest with a scripted
 *      mock teacher that emits a research tool call → the tool part resolves
 *      IMMEDIATELY with the fire-and-forget ack (the teacher's turn
 *      CONTINUES — no turn break at the call), a job record exists, and the
 *      test runner (fake deliver) produces the steer
 *   4. runner completion: a fake researcher model (web_search call → final
 *      text brief, globalThis.fetch stubbed) → the job stores the result,
 *      the steer carries the brief + sources, the fake deliver flips the
 *      job done
 *   5. runner failure: a model that throws → the failure steer still fires
 *      (the teacher learns the outcome) and the job lands error
 *   6. the wake pipeline (src/server/jobs.ts): server-side steer delivery —
 *      happy path (fires the injected turn runner, flips the job), pending-
 *      quiz deferral, 409 retry, idempotent redelivery
 *
 * Cleanup follows tests/chat-flow.test.ts: created chat/job files removed in
 * finally blocks / the after() hook.
 */
export {};
//# sourceMappingURL=jobs.test.d.ts.map