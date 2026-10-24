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

// ─── Async sub-agent jobs (vision §2.5; plan.md Wave 0 protocol) ────────────

/** An open set: whoever dispatches a job names its kind ("research", …). */
export type JobKind = string;
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
	inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number } | undefined;
	outputTokens?: number | undefined;
	outputTokenDetails?: { reasoningTokens?: number } | undefined;
}

/** pi-ai's Usage shape (input/output/cacheRead/cacheWrite/reasoning?) →
 * UsageStepLike. Structural — no pi import here; the engine band maps at
 * its boundaries. */
export function piUsageToStep(usage: {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
}): UsageStepLike {
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		inputTokenDetails: { cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite },
		outputTokenDetails: usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : undefined,
	};
}

/** Fold one model call's usage into the run's running total (pure). A
 * field neither the total nor the step reported stays undefined; once
 * reported, later unreported calls contribute 0. The `steps` counter is
 * the billing count: one per model call, reported or not. */
export function accumulateJobUsage(
	total: JobUsage | undefined,
	model: string,
	step: UsageStepLike,
): JobUsage {
	const add = (a: number | undefined, b: number | undefined): number | undefined =>
		a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
	return {
		model,
		inputTokens: add(total?.inputTokens, step.inputTokens),
		outputTokens: add(total?.outputTokens, step.outputTokens),
		cacheReadTokens: add(total?.cacheReadTokens, step.inputTokenDetails?.cacheReadTokens),
		cacheWriteTokens: add(total?.cacheWriteTokens, step.inputTokenDetails?.cacheWriteTokens),
		reasoningTokens: add(total?.reasoningTokens, step.outputTokenDetails?.reasoningTokens),
		steps: (total?.steps ?? 0) + 1,
		lastStep: {
			inputTokens: step.inputTokens,
			outputTokens: step.outputTokens,
			cacheReadTokens: step.inputTokenDetails?.cacheReadTokens,
			cacheWriteTokens: step.inputTokenDetails?.cacheWriteTokens,
			reasoningTokens: step.outputTokenDetails?.reasoningTokens,
		},
	};
}

/**
 * THE ASYNC PROTOCOL — "ack now, steer later" (the pi sub-agents model):
 *
 *  1. A job tool is SERVER-EXECUTED. The model calls one MID-TURN; execute
 *     creates the job record, fires a background runner, and resolves
 *     IMMEDIATELY with an acknowledgement. The turn does NOT end at the
 *     call: the agent keeps working and the tool part's output is the ack,
 *     forever. (No job tools are registered today; the registry, wake
 *     pipeline, dock and cards stay as the generic seam.)
 *
 *  2. The runner tracks a live activity line in the job record. ONE central
 *     client poll of GET /api/jobs?chatId=… (in Chat) drives every job
 *     surface: transcript cards, the sub-agents sidebar panel, and the
 *     single re-sync when a job settles.
 *
 *  3. On completion the runner builds a STEER MESSAGE (buildSubagentSteer)
 *     and hands it to the wake pipeline (src/server/jobs.ts): a user-role
 *     result-carrying native marker whose content is what the MODEL needs;
 *     `details` carries what the UI renders.
 *
 *  4. The wake pipeline delivers the steer by firing a SERVER-SIDE turn
 *     through the same turn composition as a client request — write-ahead
 *     persist, turn liveness: one code path. A per-chat serialized queue: a
 *     steer waits while a turn is in flight OR a question tool part is
 *     pending, then fires; a 409 retries. Delivery is idempotent per jobId,
 *     so a crashed wake can be re-entered by the stale-job recovery sweep.
 *
 *  5. No pending job parts ever exist, so the composer never gates on jobs.
 */

/** A job's result — the generic shape every steer carries. `brief` is the
 *  model-facing text; `failed` marks the failure shape. Producers may add
 *  their own fields for their cards. */
export interface JobResult {
	brief: string;
	failed?: boolean;
	[key: string]: unknown;
}

// ─── Sub-agent steer messages (THE ASYNC PROTOCOL §3–4) ─────────────────────
//
// Wave B (owner-approved 2026-09-26): steers are NATIVE record messages —
// LhMarkerMessage customs (role "custom"), the custom-message taxonomy's
// wake members. The model-facing text rides `content` (single-sourced
// below); the UI payload (the artifact, the abort badge) rides `details`
// and never reaches the model (toLlmMessages maps the marker to a user
// message carrying `content` only). The deterministic id (`steer_<jobId>`)
// IS the idempotency key — steerDelivered matches on it.

/** Message metadata marking a sub-agent steer (contracts.ts §3). */
export interface SubagentResultMeta {
	jobId: string;
	kind: JobKind;
	toolCallId: string;
	/** Present only on an abort steer: the user aborted the job (it lands
	 * as error "Aborted by learner"); the agent is told so its promise of
	 * a result doesn't hang silently. */
	aborted?: true;
}

/** The data-subagent-artifact part payload: what the UI renders. */
export interface SubagentArtifactData {
	kind: JobKind;
	result: JobResult;
}

/** A result steer's marker details: the UI's meta + the result in one
 *  payload. */
export interface SteerDetails extends SubagentResultMeta {
	result: JobResult;
}

/** Anything the wake pipeline may queue and deliver — a native marker. */
export type SteerMessage = LhMarkerMessage;

/** Whether a result is the failure shape. */
export function isSubagentFailure(_kind: JobKind, result: JobResult): boolean {
	return result.failed === true;
}

/** The model-facing text of a steer: what the result IS. */
function steerText(kind: JobKind, result: JobResult): string {
	if (isSubagentFailure(kind, result)) {
		return `The ${kind} job failed: ${result.brief}\n\nContinue with what you can establish and flag the gap.`;
	}
	return `The ${kind} job is complete — its result follows.\n\n${result.brief}`;
}

/**
 * Build the steer message for a finished job (pure — shared by the runner,
 * the wake pipeline, and tests). Deterministic id per job makes re-delivery
 * idempotent.
 */
export function buildSubagentSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
	result: JobResult,
): SteerMessage {
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-steer",
		content: steerText(job.kind, result),
		display: true,
		details: {
			jobId: job.id,
			kind: job.kind,
			toolCallId: job.toolCallId,
			result,
		},
		timestamp: Date.now(),
	};
}

/** Build the abort steer for an aborted job (pure — shared by the
 * abort path in src/server/jobs.ts and tests). Same id space as the result
 * steer (exactly one delivers). */
export function buildAbortSteer(
	job: Pick<JobRecord, "id" | "kind" | "toolCallId">,
): SteerMessage {
	const meta = { jobId: job.id, kind: job.kind, toolCallId: job.toolCallId, aborted: true } as const;
	return {
		id: `steer_${job.id}`,
		role: "custom",
		customType: "subagent-abort",
		content: `The ${job.kind} job was aborted by the user — no result is coming. Acknowledge it in one line and continue without it (a re-dispatch is fine if the user wants it).`,
		display: true,
		details: meta,
		timestamp: Date.now(),
	};
}

/** True when the transcript already carries this steer — idempotent
 *  delivery: every steer id is deterministic per its event
 *  (steer_<jobId> for jobs). */
export function steerDelivered(messages: LhMessage[], steerId: string): boolean {
	return messages.some((m) => m.id === steerId);
}
