/**
 * Sub-agent job contracts — the async ack-and-steer protocol
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers; type-only imports
 * of "ai" (safe everywhere: server, client, tests). See docs/vision.md.
 */
import type { CallUsage } from "./chat.ts";
import type { LhMessage, LhMarkerMessage } from "../native-messages.ts";
export type JobKind = "research" | "demo" | "visual" | "pdf";
export type JobStatus = "running" | "done" | "error";
export interface JobRecord {
    id: string;
    kind: JobKind;
    chatId: string;
    /** The tool part this job fulfills. */
    toolCallId: string;
    status: JobStatus;
    /** Latest human-readable activity line, e.g. `web_search: "sigma.js v3"`. */
    activity: string;
    createdAt: string;
    updatedAt: string;
    /** The sub-agent's result (steer-artifact payload). */
    result?: unknown;
    error?: string;
    /** Money channel (observability, 2026-09): accumulated token usage of
     * the sub-agent's run, written by the runner as steps complete. Cost is
     * inferred at read time (core/prices.ts). Absent on pre-2026-09 jobs and
     * until the runner's capture lands — renderers show "—", never zero. */
    usage?: JobUsage;
}
/** A sub-agent run's accumulated usage — the same accounting shape as a
 * chat turn (contracts/chat.ts CallUsage), flattened to one running total
 * plus a step count. Token fields are optional exactly like CallUsage: a
 * field NO model call reported stays undefined — absent is not zero (the
 * money-channel doctrine; cost renders "—", never $0). */
export interface JobUsage {
    /** The model that ran the sub-agent, provider-qualified ("provider:id" —
     *  model slots wave, 2026-09-20; matches PRICES' uniform keys). */
    model: string;
    /** Running totals summed over the run's model calls so far. */
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    cacheReadTokens: number | undefined;
    cacheWriteTokens: number | undefined;
    reasoningTokens: number | undefined;
    /** How many model calls the run has made (each bills separately). */
    steps: number;
    /** The MOST RECENT model call's accounting (2026-09 dock contract): the
     *  per-blob context line reads last-step input+output against the
     *  model's LIVE catalog limit (server-joined onto the activity feed —
     *  never the cumulative totals, never a client-side table). Absent
     *  until the first call completes; absent provider fields stay absent
     *  (never zero). */
    lastStep?: CallUsage;
}
/** The per-model-call usage shape we fold into JobUsage — the SDK's
 * LanguageModelUsage narrowed structurally (no runtime "ai" import: any
 * object with these fields folds, including the real thing and test fakes). */
export interface UsageStepLike {
    inputTokens?: number | undefined;
    inputTokenDetails?: {
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
    } | undefined;
    outputTokens?: number | undefined;
    outputTokenDetails?: {
        reasoningTokens?: number;
    } | undefined;
}
/** pi-ai's Usage shape (input/output/cacheRead/cacheWrite/reasoning?) →
 * UsageStepLike. Structural — no pi import here; the engine band maps at
 * its boundaries. */
export declare function piUsageToStep(usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
}): UsageStepLike;
/** Fold one model call's usage into the run's running total (pure). A
 * field neither the total nor the step reported stays undefined; once
 * reported, later unreported calls contribute 0. The `steps` counter is
 * the billing count: one per model call, reported or not. */
export declare function accumulateJobUsage(total: JobUsage | undefined, model: string, step: UsageStepLike): JobUsage;
/**
 * THE ASYNC PROTOCOL — "ack now, steer later" (the pi sub-agents model,
 * vision §2.5):
 *
 *  1. Job tools (research / demo / visual / pdf) are SERVER-EXECUTED. The model
 *     calls one MID-TURN; execute creates the job record, fires the
 *     background runner, and resolves IMMEDIATELY with an acknowledgement
 *     ("dispatched — continue your turn"). The teacher's turn does NOT end
 *     at the call: it keeps teaching, may dispatch other independent jobs
 *     (full parallelism), and ends whenever it ends. The tool part's output
 *     is the ack, forever.
 *
 *  2. The background runner (src/agent/subagents/runner.ts) runs the kind's
 *     sub-agent loop — isolated context, modelFor(role), the
 *     verify-never-one-shot doctrine (headless-tested demos, looked-at SVGs,
 *     sourced briefs) — tracking a live activity line in the job record.
 *     ONE central client poll of GET /api/jobs?chatId=… (in Chat) drives every
 *     job surface: the transcript dispatch cards (live activity by
 *     toolCallId, quiet one-liner after delivery), the sub-agents sidebar
 *     panel, and the single re-sync when a job settles.
 *
 *  3. On completion the runner builds a STEER MESSAGE (buildSubagentSteer)
 *     and hands it to the wake pipeline (src/server/jobs.ts): a user-role
 *     result-carrying native marker — the content is what the MODEL needs
 *     (the research brief, the builder's notes), plus a data-subagent-artifact
 *     part with what the UI renders (the full result: brief + sources /
 *     SVG / demo HTML). Provider conversion drops data parts, so artifact
 *     payloads never enter the teacher's context. metadata.subagentResult
 *     identifies the job; the UI renders these as sub-agent result cards,
 *     NEVER as learner interjections.
 *
 *  4. The wake pipeline delivers the steer by firing a SERVER-SIDE teacher
 *     turn through the same turn composition as a client request
 *     (handleChatRequest) — write-ahead persist, turn liveness, extraction
 *     trigger: one code path. A per-chat serialized queue: a steer waits
 *     while a turn is in flight OR a question tool part is pending (an
 *     unanswered client-side tool call breaks provider conversion — the
 *     steer fires right after the learner's continuation), then fires; a 409
 *     (a client turn raced in) retries. Delivery is idempotent per jobId, so
 *     a crashed wake can be re-entered by the stale-job recovery sweep. The
 *     job's status flips to done/error only AFTER the wake turn completes —
 *     a polling client that sees the flip re-syncs once and gets the
 *     finished record.
 *
 *     CONTINUATION COALESCING: the idle window above can starve — a
 *     quiz-chaining teacher ends every turn with a new pending check, so
 *     the gates never stay open long enough for a wake to fire. The fix:
 *     when a client turn wins the turn registry, the handler CLAIMS every
 *     queued, undelivered steer (jobs.ts claimSteers) and appends it after
 *     the learner's answer in that very turn — conversion-safe, because the
 *     answered quiz carries its output. Every answer flushes pending
 *     steers immediately; the wake pump remains for turns that end with no
 *     pending question. The pump re-checks steerDelivered right before
 *     firing, so a claim racing the pump converges to exactly one delivery.
 *
 *  5. No pending job parts ever exist, so the composer never gates on jobs
 *     (the learner can interject mid-job; the steer queues behind their
 *     turn) and job tool outputs never trigger the client-side
 *     sendAutomatically continuation — that mechanism stays quiz/ask-only.
 */
export interface ResearchToolInput {
    question: string;
    /** What the teacher needs it for — focuses the research brief. */
    context?: string;
}
export interface ResearchResult {
    brief: string;
    sources: {
        title: string;
        url: string;
    }[];
}
export interface DemoToolInput {
    title: string;
    /** Precise brief: concept, parameters/interactions, visual style. */
    brief: string;
}
export interface DemoResult {
    title: string;
    /** Self-contained single-file HTML/JS document (sandboxed-iframe ready). */
    html: string;
    /** The builder sub-agent headlessly executed the demo before delivery. */
    tested: true;
    notes?: string;
}
export interface VisualToolInput {
    /** Precise brief for ONE visual (what it must show, exactly). */
    brief: string;
}
export interface VisualResult {
    /** Complete SVG markup (verified by the maker looking at the render). */
    svg: string;
    notes?: string;
}
/** The pdf-reader (sources v0, 2026-09): reads a learner-provided PDF on
 *  the teacher's behalf — triage, targeted extraction, look-at-the-page
 *  renders inside its own loop — and returns a text brief with page
 *  citations (user-decided: rendered images never leave the sub-agent's
 *  context; the teacher gets text). */
export interface PdfToolInput {
    /** Path to the learner's PDF (relative or absolute). */
    path: string;
    /** What the teacher needs from the document — focuses the brief. */
    question: string;
}
export interface PdfResult {
    path: string;
    question: string;
    /** The distilled brief. Page citations inside the text point at
     *  pagesConsulted. Failure shape: /^PDF failed:/i (mirrors research). */
    brief: string;
    /** Pages the reader actually READ — extract or render output entered the
     *  loop (the honest count for the UI badge; search-hit snippets don't
     *  count — sources v1 split, 2026-09-19, after the "78 pages consulted"
     *  overstatement on a long-book search-first read). */
    pagesRead: number[];
    /** Every page whose content entered the loop, search-hit context lines
     *  included — the full audit set (the brief's citations may point here). */
    pagesConsulted: number[];
}
/** Message metadata marking a sub-agent steer (contracts.ts §3). */
export interface SubagentResultMeta {
    jobId: string;
    kind: JobKind;
    toolCallId: string;
    /** Present only on an abort steer (2026-09 abort semantics): the
     * learner aborted the job (it lands as error "Aborted by learner");
     * the teacher is told so its promise of a result doesn't hang
     * silently in the lesson. */
    aborted?: true;
}
/** The data-subagent-artifact part payload: what the UI renders. */
export interface SubagentArtifactData {
    kind: JobKind;
    result: ResearchResult | DemoResult | VisualResult | PdfResult;
    /** The learner's pinned UI state (invert switch) riding the record. */
    ui?: {
        inverted?: boolean;
    };
}
/** A result steer's marker details: the UI's meta + artifact in one
 *  payload (the projection splits it into metadata + data part). */
export interface SteerDetails extends SubagentResultMeta {
    result: ResearchResult | DemoResult | VisualResult | PdfResult;
    /** LEARNER UI state pinned onto the artifact (owner, 2026-10-07): the
     *  invert switch's position, persisted so navigating away and back (or
     *  restarting) keeps it. A VIEW preference — never enters the teacher's
     *  context, never exports (the markdown engine reads `result` only). */
    ui?: {
        inverted?: boolean;
    };
}
/** Set a steer message's ui.inverted (pure): returns a NEW message array
 *  with the target's details updated — no-op (same array) when the message
 *  is missing or not an invertible artifact steer. The silent route's
 *  whole body. */
export declare function setSteerUiInverted(messages: readonly LhMessage[], messageId: string, inverted: boolean): LhMessage[];
/** Anything the wake pipeline may queue and deliver — a native marker. */
export type SteerMessage = LhMarkerMessage;
/** Whether a result is the failure shape (html/svg empty, failure brief). */
export declare function isSubagentFailure(kind: JobKind, result: ResearchResult | DemoResult | VisualResult | PdfResult): boolean;
/**
 * Build the steer message for a finished job (pure — shared by the runner,
 * the wake pipeline, and tests). Deterministic id per job makes re-delivery
 * idempotent.
 */
export declare function buildSubagentSteer(job: Pick<JobRecord, "id" | "kind" | "toolCallId">, result: ResearchResult | DemoResult | VisualResult | PdfResult): SteerMessage;
/** Build the abort steer for an aborted job (pure — shared by the
 * abort path in src/server/jobs.ts and tests). Same id space as the result
 * steer (same id space — exactly one delivers). */
export declare function buildAbortSteer(job: Pick<JobRecord, "id" | "kind" | "toolCallId">): SteerMessage;
export declare function buildProbeHandoffSteer(chatId: string): SteerMessage;
/** True when the transcript already carries this steer — idempotent
 *  delivery for ANY steer kind: every steer id is deterministic per its
 *  event (steer_<jobId> for jobs, steer_probe_<chatId> for the handoff). */
export declare function steerDelivered(messages: LhMessage[], steerId: string): boolean;
//# sourceMappingURL=jobs.d.ts.map