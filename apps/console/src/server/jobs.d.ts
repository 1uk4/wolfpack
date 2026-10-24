/**
 * THE WAKE PIPELINE (contracts.ts "THE ASYNC PROTOCOL" §4) — server-side
 * steer delivery for finished sub-agent jobs. Wave C (2026-09-26):
 * delivery rides pi's OWN follow-up queue when a run is live, and the
 * idle wake otherwise. One registry, two vehicles.
 *
 *   deliverJobResult(steer) — the runner calls this on job completion.
 *     The steer joins a per-chat serialized registry and the pump drives
 *     it along ONE of two paths:
 *
 *       1. LIVE RUN → pi steering: the marker is handed to the LIVE
 *          agent's steering queue (agent.steer). pi polls that queue at
 *          TURN BOUNDARIES — after a completed assistant message AND its
 *          tool results (never between a toolCall and its result), and
 *          again at the run's start (a continuation drains the queue
 *          BEFORE its first LLM call) — and CONTINUES THE SAME RUN: the
 *          marker joins the context mid-lesson, rides the live event
 *          stream (message_start/message_end), and lands in the record
 *          at that run's persist. This is the owner's 2026-09-26
 *          correction: a real lesson is one continuous teach→quiz→teach
 *          loop, so delivery must happen BETWEEN messages inside the
 *          run — waiting for the run to stop (follow-ups) only ever
 *          fires at a stopper exit, which is exactly when it must not.
 *          The question stopper runs BEFORE the post-turn poll and
 *          exits the loop, so a quiz-terminated run never injects: the
 *          handed marker strands (see settleSteers) and waits — the
 *          ANSWER run then picks it up at its start poll. probe-handoff
 *          markers NEVER take this path (owner ruling: the handoff must
 *          start the TEACHER's run — a record-level branch only a fresh
 *          wake can make).
 *       2. IDLE WAKE: no live turn. WAIT FOR IDLE (turn-liveness OR a
 *          dangling question — an unanswered client-side tool call breaks
 *          provider conversion), then fire ONE server-side wake turn
 *          carrying EVERY queued marker as its input appends (write-ahead
 *          persist, liveness, extraction — one code path, the same
 *          composition as a client request). A 409 means a client turn
 *          raced in — re-queue and retry with backoff. Idempotent per
 *          jobId (steerDelivered): a crashed wake or a duplicate deliver
 *          is skipped, not duplicated.
 *
 *   settleSteers(chatId, persisted) — the handler calls this at turn
 *     settlement (after unregisterLiveAgent): entries the run DELIVERED
 *     resolve + flip their jobs; entries that were handed to the dying
 *     run but never injected (stopper exit, abort, a missed final poll)
 *     return to pending and the pump restarts — no stranding, no loss.
 *
 *   Crash recovery (recoverStaleJobs): a process restart can orphan jobs —
 *     "running" with a result (the wake never fired) or without one (the
 *     sub-agent loop itself died). The sweep re-delivers finished results
 *     (idempotently) and re-spawns unfinished loops, both via injected
 *     seams. It runs lazily off the /api/jobs poll, throttled.
 *
 * All mutable state lives on globalThis (the turn-liveness lesson: Next dev
 * gives each route entry its own module instances — a module-level Map would
 * be a different object in each).
 */
import { type JobRecord, type SteerMessage } from "../core/contracts.ts";
import type { TurnInput } from "../core/input-events.ts";
import { type LhMessage } from "../core/native-messages.ts";
import type { Agent } from "@earendil-works/pi-agent-core";
/** Fires one server-side teacher turn: (chatId, input) → HTTP-ish status.
 *  Wave C: the input is the IDLE WAKE — every queued marker as the turn's
 *  input appends (the handler appends them natively under the wake's own
 *  turn claim; one composition for every turn). */
export type TurnRunner = (chatId: string, input: TurnInput) => Promise<number>;
/** Re-runs a job's sub-agent loop (crash recovery for orphaned jobs). */
export type JobRespawn = (jobId: string) => void;
/** chat-handler wires this at module init: its adapter around handleChatRequest. */
export declare function setTurnRunner(run: TurnRunner): void;
/** chat-handler wires this at module init: its job runner's runJob. */
export declare function setJobRespawn(respawn: JobRespawn): void;
/** Dock bookkeeping: the marker reached the learner's view — flip its job
 *  NOW instead of waiting for the delivering turn to settle. Called from
 *  BOTH visibility seams: the marker's message_end wire event (live steer
 *  injection — the card is on screen while the teacher keeps teaching) and
 *  the write-ahead persist in handleChatInput (the wake's input appends —
 *  the card is durable in the record). The registry's delivery promise
 *  still settles via settleSteers / the runner-200 path; finalizeJob is
 *  idempotent, so the later flip is a no-op. Owner ruling (2026-09-26): a
 *  delivered subagent leaves the background dock the moment its result is
 *  visible, not when the teacher's turn ends. */
export declare function noteSteerVisible(steer: SteerMessage): void;
/** Queue ANY steer (result, abort, probe handoff) through the pipeline.
 *  Resolves when the wake turn has completed; rejects when delivery fails
 *  unrecoverably. Never rejects for queueing itself. */
export declare function deliverJobResult(steer: SteerMessage): Promise<void>;
/** The chat-handler registers the CURRENTLY STREAMING turn's agent BEFORE
 *  runPiTurn (the loop's start steering-poll drains synchronously inside
 *  that call — a later registration would miss it). Pending registry
 *  markers are steered into the run right here. The settle seam cannot
 *  beat the registration: settlement needs a streamed response, which
 *  never happens inside the constructor call. */
export declare function registerLiveAgent(chatId: string, agent: Agent): void;
/** A parked user steer: the message plus the agent it was last handed to
 *  (the double-handoff guard — a reconcile keeps it only when its id
 *  never landed in the persisted record). */
export interface UserSteerEntry {
    message: LhMessage;
    handedTo?: Agent;
}
/** The steer route's live hand-off (composer steering, 2026-10-03).
 *  Synchronous by design — no interleaving between the live-agent check
 *  and the queue() means a settling turn can never race the hand-off.
 *  Returns false when no turn is live: the caller 409s and the client
 *  falls back to a plain text send (the settle race). The registry copy
 *  is the stranding safety net: if this agent dies undelivered (question
 *  termination, abort), reconcileUserSteers keeps it parked for the
 *  chat's next run. */
export declare function steerLiveChat(chatId: string, message: LhMessage): boolean;
/** TURN SETTLEMENT RECONCILIATION for user steers: delivered ids drop
 *  (the record holds them); undelivered stay parked for the next run.
 *  Memory-only by design (same tradeoff as job markers): a server
 *  restart drops parked steers — and the whole turn dies with it anyway. */
export declare function reconcileUserSteers(chatId: string, persisted: readonly LhMessage[]): void;
/** Clear the live agent at settlement — MUST run before settleSteers so the
 *  reconciliation's re-pump can never hand a marker to the dying agent. */
export declare function unregisterLiveAgent(chatId: string): void;
/** TURN SETTLEMENT RECONCILIATION (Wave C): the handler calls this AFTER
 * unregisterLiveAgent, with the run's persisted messages. Two jobs:
 *
 *   - entries whose marker the run DELIVERED (in-run follow-up injection —
 *     their ids are in the persisted slice) resolve and flip their jobs;
 *   - entries handed to the dying run but never injected (the question
 *     stopper exited before the follow-up poll; an abort; a delivery that
 *     raced the final poll) return to PENDING (handedTo cleared) and the
 *     pump restarts — the idle wake delivers them once the gates open.
 *
 * This is what makes the live hand-off safe: pi owns no retry for a marker
 * stranded in a settled agent's queue, so the registry stays the truth and
 * the dead agent's copy is simply abandoned (GC'd with the agent). */
export declare function settleSteers(chatId: string, persisted: {
    id?: string;
}[]): void;
/** Result of an abort attempt — the endpoint maps these to HTTP. */
export interface AbortOutcome {
    ok: boolean;
    reason?: "not_found" | "not_running";
}
/**
 * ABORT (2026-09 dock semantics, user-decided): real kill, error with
 * reason, the teacher still learns. The dock's END button reaches this
 * through POST /api/activity/abort (body {kind: "job", id: jobId}); the
 * route is master's thin composition — this is the job-side mechanism.
 * Four things happen, in order:
 *
 *   1. KILL the spend: fire the job's registered AbortController (the
 *      runner registered it at loop start) — the in-flight model call
 *      aborts, not just the next loop check. The runner unwinds silently
 *      (its catch checks abortSignal.aborted; finishJob checks status).
 *   2. DROP any queued result steer for this job (the delivering-result
 *      phase): resolve its entry without firing the wake. If the wake
 *      turn is ALREADY in flight (the pump shifted the entry), it's too
 *      late — the result steer lands, and the cancellation steer dedupes
 *      against it via steerDelivered (same jobId metadata).
 *   3. FLIP the record to error "Aborted by learner" immediately — the
 *      poll reflects the user's action at once (the user chose
 *      error-with-reason over a distinct cancelled status). finalizeJob
 *      never overwrites a non-running status, so the flip is terminal no
 *      matter what the wake does.
 *   4. STEER the teacher: a one-line abort note (buildAbortSteer) through
 *      the same wake pipeline, so the teacher's promise of a result
 *      doesn't hang silently in the lesson.
 *
 * The runner writes the usage folded so far in its finally (merge patch),
 * so an aborted job's money record survives the kill.
 */
export declare function abortJob(jobId: string): AbortOutcome;
/**
 * Lazy sweep (called off the /api/jobs poll, throttled), LIVENESS-GATED
 * (accuracy wave, 2026-09-19): a "running" record without a live loop
 * registration (subagents/aborts.ts) is an orphan of a process death —
 * re-deliver its stored result (idempotently) or re-spawn the loop, at
 * once (the old 15-minute age heuristic waited on ghosts AND re-ran
 * hung-but-alive loops beside themselves — the figure-maker incident,
 * 2026-09-18). A record WITH a live registration is provably executing
 * in THIS process — never touched, however old: a hung first model call
 * (zero usage ever billed) stays honestly "running" in the dock until
 * END kills it. The abort registration spans loop start to delivery
 * completion, so a live registration can never belong to a dead run.
 */
/** Re-run a job's sub-agent loop — exposed for the sweep's tests (the
 *  /api/jobs poll is its only production caller, disabled under NODE_ENV=test). */
export declare function recoverStaleJobs(): void;
/** The /api/jobs entry: job list for the client poll (+ lazy recovery). */
export declare function listJobs(chatId: string): JobRecord[];
//# sourceMappingURL=jobs.d.ts.map