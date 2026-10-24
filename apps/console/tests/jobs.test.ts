/**
 * Job infrastructure tests — deterministic, zero network:
 *
 *   1. job store CRUD (create → get → update → list → dedup by toolCallId)
 *   2. steer helpers (pure, contracts.ts): buildSubagentSteer shape,
 *      isSubagentFailure, steerDelivered
 *   3. the wake pipeline (src/server/jobs.ts): server-side steer delivery —
 *      happy path (fires the injected turn runner, flips the job), pending-
 *      quiz deferral, 409 retry, idempotent redelivery
 *   4. abort, crash recovery, composer steering
 *
 * Cleanup follows tests/chat-flow.test.ts: created chat/job files removed in
 * finally blocks / the after() hook.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type AssistantMessage, type FauxResponseStep } from "@earendil-works/pi-ai";
import {
	accumulateJobUsage,
	buildAbortSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type JobResult,
	type JobUsage,
	type SteerMessage,
} from "../src/core/contracts.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import {
	abortJob,
	deliverJobResult,
	noteSteerVisible,
	reconcileUserSteers,
	recoverStaleJobs,
	registerLiveAgent,
	setJobRespawn,
	setTurnRunner,
	settleSteers,
	steerLiveChat,
	unregisterLiveAgent,
} from "../src/server/jobs.ts";
import { registerJobAbort, unregisterJobAbort } from "../src/agent/subagents/aborts.ts";
import { beginTurn, endTurn } from "../src/server/turn-liveness.ts";
import { persistTurn } from "../src/server/turn-service.ts";
import { chatStore } from "../src/store/chats.ts";
import { jobStore } from "../src/store/jobs.ts";
import type { PiEngine } from "../src/agent/models.ts";
import { PATHS } from "../config.ts";
import { projectView as projectNative } from "../src/core/view.ts";
import { subscribe } from "../src/core/events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { SteerInput, TurnInput } from "../src/core/input-events.ts";

const JOBS_DIR = path.join(PATHS.data, "jobs");

const createdChats: string[] = [];

// The key-presence turn gate (provider-key interlude, 2026-09-25): scripted
// turns pin openrouter per chat — the gate reads env-first truth, so the
// key must be present in the test process like any real setup.
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
const createdJobs: string[] = [];

function trackChat(id: string) {
	createdChats.push(id);
}

/** Wave B native fixture: user text + an assistant tool call + its ack —
 *  the record is agent history; the runner's transcript scan (input
 *  resolution) reads it through the projection. */
function nativeToolMessages(text: string, tool: string, toolCallId: string, input: unknown): LhMessage[] {
	return [
		{ id: "u1", role: "user", content: text, timestamp: 1 } as never,
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: tool, arguments: input as never }],
			api: "openai-completions",
			provider: "openrouter",
			model: "test",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			stopReason: "toolUse",
			timestamp: 1,
		} as never,
		{
			id: "r1",
			role: "toolResult",
			toolCallId,
			toolName: tool,
			content: [{ type: "text", text: "Dispatched." }],
			details: "Dispatched.",
			isError: false,
			timestamp: 1,
		} as never,
	];
}

function trackJob(id: string) {
	createdJobs.push(id);
}

/* THE HERMETICITY FENCE (owner round 7, 2026-10-05): the jobs seams are
 * MODULE-GLOBAL (setJobRespawn / setTurnRunner / the abort registry) and
 * the sweep scans EVERY job in the store. An async test that times out
 * under full-suite load leaves a "running" record and a late wake behind
 * — and that stray state then poisons the NEXT test (a foreign respawn
 * lands in its counter; a foreign orphan in its sweep). Under isolation
 * nothing ever times out, which is why the file passes alone and flaked
 * in the full run. The fence makes every test's start state identical:
 * all tracked jobs settled, aborts unregistered, seams inert. */
afterEach(() => {
	for (const id of createdJobs) {
		try {
			const job = jobStore.getJob(id);
			if (job && job.status === "running") {
				jobStore.updateJob(id, { status: "done", activity: "settled (fence)" });
			}
			unregisterJobAbort(id);
		} catch {
			/* already gone */
		}
	}
	// Late wakes from a prior test must be inert: a no-op respawn can't
	// increment anyone's counter, a no-op runner can't spawn real work.
	setJobRespawn(() => {});
	setTurnRunner(async () => 200);
});

after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
	for (const id of createdJobs) {
		try {
			fs.unlinkSync(path.join(JOBS_DIR, `${id}.json`));
		} catch {
			/* already gone */
		}
	}
});

/** A scripted pi engine (faux provider): the response queue replaces the
 *  old doStream/doGenerate turn counters. tokenSize is set so every test
 *  string streams as ONE delta — the SSE-body assertions ("Back with the
 *  brief.") read contiguous text. */
function fauxEngine(steps: FauxResponseStep[]): PiEngine {
	const faux = createFauxCore({ tokenSize: { min: 64, max: 64 } });
	faux.setResponses(steps);
	return { model: faux.getModel(), streamFn: faux.streamSimple };
}

/** A scripted response factory whose model call never resolves until its
 *  abort signal fires (a cancelled provider request); an already-aborted
 *  signal resolves at once — the faux stream then ends the message aborted. */
function abortableFactory(): FauxResponseStep {
	const factory = (_context: unknown, options: { signal?: AbortSignal } | undefined) =>
		new Promise<AssistantMessage>((resolve) => {
			const sig = options?.signal;
			if (sig?.aborted) {
				resolve(fauxAssistantMessage("late"));
				return;
			}
			sig?.addEventListener("abort", () => resolve(fauxAssistantMessage("late")), { once: true });
		});
	return factory as unknown as FauxResponseStep;
}

async function drain(res: Response): Promise<string> {
	if (res.status !== 200) {
		assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
	}
	return res.text();
}

/** CONNECTION DIET B (owner, 2026-10-10): the POST acks and closes; drain
 *  the turn's wire through the reattach stream instead. */
async function drainTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<string> {
	const cloned = req.clone();
	const ack = await handleChatRequest(req, factory);
	if (ack.status !== 200) {
		assert.fail(`expected 200 ack, got ${ack.status}: ${await ack.text()}`);
	}
	const { chatId } = (await cloned.json()) as { chatId: string };
	const handle = runningTurn(chatId);
	if (!handle) return ""; // the turn settled inside the handler — completion already happened
	return new Response(handle.subscribe()).text();
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		// Wave B: the input-events contract — one explicit event, never a
		// client transcript.
		body: JSON.stringify({ chatId, input }),
	});
}

/* 30s budget (owner round, 2026-10-05): under the FULL suite's parallel
 * load the event loop starves and an 8s wall-clock budget expired before
 * healthy conditions were ever observed — and a timed-out delivery leaked
 * a late wake into the NEXT test (the respawn hook is module-global),
 * poisoning even synchronous neighbors. waitFor returns the instant the
 * condition holds, so the generous budget costs nothing when healthy. */
function waitFor(cond: () => boolean, timeoutMs = 30_000, what = "condition"): Promise<void> {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (cond()) return resolve();
			if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting for ${what}`));
			setTimeout(tick, 25);
		};
		tick();
	});
}

// ─── 1. job store CRUD ───────────────────────────────────────────────────────

describe("job store", () => {
	it("create → get → update → list round-trips", () => {
		const job = jobStore.createJob({ kind: "research", chatId: "chat_storetest", toolCallId: "call-store" });
		trackJob(job.id);

		assert.match(job.id, /^job_/);
		assert.equal(job.status, "running");
		assert.equal(job.activity, "starting");

		const loaded = jobStore.getJob(job.id)!;
		assert.equal(loaded.toolCallId, "call-store");
		assert.equal(loaded.kind, "research");

		const updated = jobStore.updateJob(job.id, { activity: 'web_search: "test"', status: "done", result: { brief: "b" } })!;
		assert.equal(updated.activity, 'web_search: "test"');
		assert.equal(updated.status, "done");
		assert.ok(updated.updatedAt >= job.updatedAt);
		// immutable identity fields survive a patch
		assert.equal(updated.toolCallId, "call-store");
		assert.equal(jobStore.getJob(updated.id)!.toolCallId, "call-store");

		const listed = jobStore.listJobs("chat_storetest");
		assert.ok(listed.some((j) => j.id === job.id));
		assert.equal(jobStore.listJobs("chat_other").some((j) => j.id === job.id), false, "jobs are scoped to their chat");

		const byTool = jobStore.findJobByToolCallId("chat_storetest", "call-store");
		assert.equal(byTool?.id, job.id);
		assert.equal(jobStore.findJobByToolCallId("chat_storetest", "call-missing"), null);
	});

	// ── push-architecture S4 (2026-10-02): every WRITE announces on the
	// events channel (notify-after-write); reads stay silent ──
	it("every mutation emits jobs-changed {chatId}; reads emit nothing", () => {
		const got: { chatId?: string }[] = [];
		const off = subscribe((e) => {
			if (e.type === "jobs-changed") got.push({ chatId: e.chatId });
		});
		const job = jobStore.createJob({ kind: "research", chatId: "chat_storeemit", toolCallId: "call-emit" });
		trackJob(job.id);
		assert.deepEqual(got, [{ chatId: "chat_storeemit" }], "createJob announces after the write");
		got.length = 0;

		jobStore.updateJob(job.id, { activity: "still working" });
		assert.deepEqual(got, [{ chatId: "chat_storeemit" }], "updateJob announces on EVERY write — progress lines included");
		got.length = 0;

		jobStore.updateJob("job_missing", { activity: "noop" });
		assert.deepEqual(got, [], "a missing id wrote nothing — silent");

		jobStore.listJobs("chat_storeemit");
		jobStore.getJob(job.id);
		assert.deepEqual(got, [], "reads are silent");

		jobStore.deleteJobsForChat("chat_storeemit");
		assert.deepEqual(got, [{ chatId: "chat_storeemit" }], "a real delete announces");
		got.length = 0;
		jobStore.deleteJobsForChat("chat_storeemit");
		assert.deepEqual(got, [], "a zero-file delete wrote nothing — silent");
		off();
	});
});

// ─── 2. steer helpers (pure) ─────────────────────────────────────────────────

describe("steer helpers (contracts.ts)", () => {
	const ok: JobResult = { brief: "BRIEF" };

	it("buildSubagentSteer: a native marker — brief on the model-facing content, result payload in details", () => {
		const job = { id: "job_x", kind: "build", toolCallId: "call-x" };
		const steer = buildSubagentSteer(job, ok);
		assert.equal(steer.id, "steer_job_x", "deterministic id per job — idempotent delivery");
		// Steers are LhMarkerMessage customs — role "custom", the model
		// reads `content`, the UI reads `details` (never model-visible).
		assert.equal(steer.role, "custom");
		assert.equal(steer.customType, "subagent-steer");
		assert.equal(steer.display, true);
		assert.ok(steer.content.includes("BRIEF"), "the model-facing text carries the brief");
		const data = steer.details as { jobId: string; kind: string; toolCallId: string; result: JobResult };
		assert.equal(data.jobId, "job_x");
		assert.equal(data.kind, "build");
		assert.equal(data.toolCallId, "call-x");
		assert.deepEqual(data.result, ok);
	});

	it("accumulateJobUsage: sums per model call; fields NO call reported stay undefined (absent is not zero)", () => {
		let total: JobUsage | undefined = undefined;
		total = accumulateJobUsage(total, "z-ai/glm-5.3-flash", {
			inputTokens: 10,
			outputTokens: 5,
			inputTokenDetails: { cacheReadTokens: 4 },
		});
		assert.deepEqual(total, {
			model: "z-ai/glm-5.3-flash",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 4,
			cacheWriteTokens: undefined,
			reasoningTokens: undefined,
			steps: 1,
			lastStep: {
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 4,
				cacheWriteTokens: undefined,
				reasoningTokens: undefined,
			},
		}, "lastStep is the most recent call's accounting, not cumulative");
		// a later call that reports nothing new keeps reported fields summing
		// (unreported contributes 0) and bumps the billing step count.
		total = accumulateJobUsage(total, "z-ai/glm-5.3-flash", { inputTokens: 20, outputTokens: 0 });
		assert.equal(total.inputTokens, 30);
		assert.equal(total.outputTokens, 5);
		assert.equal(total.cacheReadTokens, 4, "unreported after reported contributes 0");
		assert.equal(total.cacheWriteTokens, undefined, "never reported stays absent — never zero");
		assert.equal(total.reasoningTokens, undefined);
		assert.equal(total.steps, 2, "one step per model call, reported or not");
		assert.deepEqual(total.lastStep, {
			inputTokens: 20,
			outputTokens: 0,
			cacheReadTokens: undefined,
			cacheWriteTokens: undefined,
			reasoningTokens: undefined,
		}, "lastStep always mirrors the LATEST call, never the sums");
	});

	it("buildAbortSteer: a subagent-abort marker — agent-facing text on content, the abort payload in details", () => {
		const steer = buildAbortSteer({ id: "job_c", kind: "build", toolCallId: "call-c" });
		assert.equal(steer.id, "steer_job_c", "same id space — steerDelivered treats either as delivered");
		assert.equal(steer.role, "custom");
		assert.equal(steer.customType, "subagent-abort");
		assert.ok(/aborted/.test(steer.content), "the agent-facing text names the abort");
		assert.ok(steer.content.includes("build"), "…and the job kind");
		assert.deepEqual(steer.details, { jobId: "job_c", kind: "build", toolCallId: "call-c", aborted: true });
	});

	it("isSubagentFailure: the failure shape only", () => {
		assert.equal(isSubagentFailure("build", ok), false);
		assert.equal(isSubagentFailure("build", { brief: "boom", failed: true }), true);
	});

	it("steerDelivered: matches on the deterministic steer id (any steer kind)", () => {
		const steer = buildSubagentSteer({ id: "job_y", kind: "build", toolCallId: "c" }, ok);
		assert.equal(steer.id, "steer_job_y");
		assert.equal(steerDelivered([], steer.id), false);
		assert.equal(steerDelivered([steer], steer.id), true);
		assert.equal(steerDelivered([steer], "steer_job_z"), false);
	});

	it("failure steers tell the agent how to recover", () => {
		const fail = buildSubagentSteer({ id: "j1", kind: "build", toolCallId: "c" }, { brief: "API down", failed: true });
		assert.ok(fail.content.includes("failed"));
		assert.ok(fail.content.includes("flag the gap"));
		assert.ok(!ok.brief.includes("failed"));
	});
});

// ─── fake deliver (the wake pipeline's stand-in for runner tests) ───────────

/**
 * A fake deliver seam: capture the steer and mimic the pipeline's final
 * status flip (done/error by isSubagentFailure) so the job record reads
 * exactly as it will in production after the wake turn completes.
 */
function fakeDeliver() {
	const steers: SteerMessage[] = [];
	return {
		steers,
		deliver: async (steer: SteerMessage) => {
			steers.push(steer);
			const jobId = (steer.details as { jobId: string }).jobId;
			const job = jobStore.getJob(jobId);
			if (job && job.status === "running") {
				const failed = job.result ? isSubagentFailure(job.kind, job.result as never) : true;
				jobStore.updateJob(jobId, { status: failed ? "error" : "done", activity: failed ? "failed" : "delivered" });
			}
		},
	};
}

// ─── 6. the wake pipeline (server-side steer delivery) ────────────────────────

/**
 * Pipeline tests drive deliverJobResult with an injected fake turn runner
 * (setTurnRunner) — the real wiring (chat-handler's handleChatRequest
 * adapter) never fires here, so no teacher model is touched.
 *
 * Timing: the pump polls at 400ms with a 1.5s grace after the gates open —
 * each happy-path test takes ~2s; waitFor tolerates it.
 */
describe("wake pipeline (src/server/jobs.ts)", () => {
	/** A chat with a finished job ready for delivery. */
	function setup(kind = "build"): { chatId: string; jobId: string; steer: SteerMessage } {
		const chat = chatStore.createChat("Test: wake pipeline");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never]);

		const job = jobStore.createJob({ kind, chatId: chat.id, toolCallId: `call-${jobStore.listJobs(chat.id).length}` });
		trackJob(job.id);
		const result: JobResult = { brief: "Done: it works." };
		jobStore.updateJob(job.id, { result, activity: "delivering result" });
		const steer = buildSubagentSteer(job, result);
		return { chatId: chat.id, jobId: job.id, steer };
	}

	it("delivers: fires the turn runner with the record + steer, then flips the job done", async () => {
		const { chatId, jobId, steer } = setup();
		let seen: { chatId: string; steers: SteerMessage[] } | undefined;
		setTurnRunner(async (cid, input) => {
			seen = { chatId: cid, steers: (input as SteerInput).steers as SteerMessage[] };
			return 200;
		});

		await deliverJobResult(steer);
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after delivery");

		assert.equal(jobStore.getJob(jobId)!.status, "done");
		assert.equal(jobStore.getJob(jobId)!.activity, "delivered");
		assert.ok(seen, "the turn runner fired");
		assert.equal(seen.chatId, chatId);
		assert.equal(seen.steers.length, 1);
		assert.equal(seen.steers[0]!.id, steer.id, "the steer IS the wake turn's input");
	});

	it("waits while a question part is pending, and fires once it clears", async () => {
		const { chatId, jobId, steer } = setup();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// A dangling question call blocks the wake (the model would reject an
		// unanswered tool call — fork 1: the record ends at the call).
		chatStore.saveMessages(chatId, [
			{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q", choices: ["a", "b"] } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
		]);

		// The delivery promise floats while the quiz blocks — awaiting it now
		// would deadlock the test (the pump defers until the gate opens).
		const delivery = deliverJobResult(steer);

		await delay(1200);
		assert.equal(fired, 0, "no wake while the quiz is pending");
		assert.equal(jobStore.getJob(jobId)!.status, "running", "job stays running while blocked");

		// The learner answers: the real tool result clears the dangling call.
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [
			...record.messages,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "quiz-call",
				toolName: "quiz",
				content: [{ type: "text", text: "answered" }],
				details: { answer: "a", correct: true, explanation: "" },
				isError: false,
				timestamp: 1,
			} as never,
		]);

		await waitFor(() => fired > 0, 8000, "wake after the quiz answer");
		await delivery; // now it resolves — the steer was delivered
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after the deferred wake");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("the dismissal pause holds deliveries — no wake until the user's next turn settles (A2)", async () => {
		const { chatId, jobId, steer } = setup();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// The record ends in a DISMISSAL (owner design 2026-10-03): the
		// question was skipped via the silent route — no dangling call (the
		// quiz gate would pass), so ONLY the dismissal pause holds the wake.
		chatStore.saveMessages(chatId, [
			{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never,
			{
				id: "a1",
				role: "assistant",
				content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q" } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			{
				id: "r1",
				role: "toolResult",
				toolCallId: "quiz-call",
				toolName: "quiz",
				content: [{ type: "text", text: "skipped" }],
				details: { kind: "quiz", questionText: "q", dontKnow: false, answers: [], dismissed: true, answeredAt: "t" },
				isError: false,
				timestamp: 1,
			} as never,
		]);

		const delivery = deliverJobResult(steer);

		await delay(1200);
		assert.equal(fired, 0, "no wake while the session sits dismissal-paused");
		assert.equal(jobStore.getJob(jobId)!.status, "running", "the delivery holds (queued, not lost)");

		// The user's next message is the wake — its turn settles, and the
		// settlement re-pump lands the held delivery right after it.
		const record = chatStore.getChat(chatId)!;
		const afterUser = [...record.messages, { id: "u2", role: "user", content: "moving on", timestamp: 2 } as never];
		chatStore.saveMessages(chatId, afterUser);
		settleSteers(chatId, afterUser);

		await waitFor(() => fired > 0, 8000, "wake after the pause lifts");
		await delivery;
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after the held wake");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("retries with backoff on a 409 (a client turn raced in) and delivers on the retry", async () => {
		const { jobId, steer } = setup();
		let calls = 0;
		setTurnRunner(async () => {
			calls++;
			return calls === 1 ? 409 : 200;
		});

		await deliverJobResult(steer);
		assert.ok(calls >= 2, "409 was retried");
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "job flip after the retry");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("is idempotent: a steer already in the transcript flips the job without firing a turn", async () => {
		const { chatId, jobId, steer } = setup();
		// Simulate the crash window: the wake completed but the flip didn't.
		const record = chatStore.getChat(chatId)!;
		chatStore.saveMessages(chatId, [...record.messages, steer] as never);

		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		await deliverJobResult(steer);
		assert.equal(fired, 0, "no duplicate wake for an already-delivered steer");
		assert.equal(jobStore.getJob(jobId)!.status, "done", "the job still flips — recovery completes");
	});

// ─── continuation coalescing (the delivery-starvation fix) ───────────────────

describe("Wave C: live steering handoff + settlement reconciliation", () => {
	/** A minimal stand-in for pi's Agent — the pump touches only steer(). */
	function fakeAgent(): { handed: SteerMessage[]; agent: unknown } {
		const handed: SteerMessage[] = [];
		return { handed, agent: { steer: (m: SteerMessage) => handed.push(m) } };
	}

	it("hands queued markers to the LIVE run (pi steering queue) — no wake fires, the registry waits", async () => {
		const { chatId, jobId, steer } = setup();
		const { handed, agent } = fakeAgent();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// A live turn is streaming (turn registry + live agent registered).
		assert.ok(beginTurn(chatId));
		registerLiveAgent(chatId, agent as never);

		const delivery = deliverJobResult(steer); // floats — resolves at settlement
		await waitFor(() => handed.length === 1, 8000, "marker handed to the live agent");
		await delay(1200);
		assert.equal(fired, 0, "no wake while the run is live");
		assert.equal(jobStore.getJob(jobId)!.status, "running", "job flips only at delivery");

		// Settlement: the run persisted the injected marker.
		unregisterLiveAgent(chatId);
		settleSteers(chatId, [steer as never]);
		await delivery;
		assert.equal(jobStore.getJob(jobId)!.status, "done", "delivery resolves at settlement");
		assert.equal(fired, 0, "never needed a wake");
		endTurn(chatId);
	});

	it("a handed marker the run never injected (stopper exit / missed poll) strands at settlement — the idle wake delivers it", async () => {
		const { chatId, jobId, steer } = setup();
		const { handed, agent } = fakeAgent();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		assert.ok(beginTurn(chatId));
		registerLiveAgent(chatId, agent as never);

		const delivery = deliverJobResult(steer);
		await waitFor(() => handed.length === 1, 8000, "handed");
		// The run settles WITHOUT the marker (question stopper exited before
		// the follow-up poll) — reconcile against the persisted truth.
		unregisterLiveAgent(chatId);
		settleSteers(chatId, []);
		endTurn(chatId);

		// The marker returned to pending — the pump's idle wake delivers it.
		await delivery;
		assert.equal(fired, 1, "the stranded marker rode the idle wake");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("registerLiveAgent immediately steers pending markers into the NEW run (the parked-behind-quiz path)", async () => {
		const { chatId, jobId, steer } = setup();
		const { handed, agent } = fakeAgent();
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});

		// A dangling question has the pump parked in waitForIdle: the
		// marker is pending but no live run exists to take it.
		chatStore.saveMessages(chatId, [
			...nativeToolMessages("teach me", "probe_done", "call-q", { ok: true }),
			{
				id: "a-q",
				role: "assistant",
				content: [{ type: "toolCall", id: "quiz-call", name: "quiz", arguments: { question: "q", choices: ["a", "b"] } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
		]);
		const delivery = deliverJobResult(steer);
		await delay(300); // let the pump park behind the dangling question
		assert.equal(handed.length, 0, "nothing to hand to — no live agent");

		// The learner answers: the handler registers the answer run's agent
		// BEFORE runPiTurn, so the marker is steered into it synchronously —
		// it rides the run's START steering poll (first LLM call).
		assert.ok(beginTurn(chatId));
		registerLiveAgent(chatId, agent as never);
		assert.equal(handed.length, 1, "registration itself steered the marker in");
		assert.equal(handed[0]!.id, steer.id);

		// The answer run persisted the marker — the parked pump's wake
		// re-check resolves it without ever firing a turn.
		unregisterLiveAgent(chatId);
		settleSteers(chatId, [steer as never]);
		endTurn(chatId);
		await delivery;
		assert.equal(fired, 0, "the parked wake never fired — the run delivered");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});

	it("noteSteerVisible flips the job at the visibility seam — before any settle (owner ruling 2026-09-26)", async () => {
		// The dock fix: the marker reaching the learner's view (wire
		// message_end / write-ahead persist) flips the job NOW — the
		// delivering turn may keep teaching for minutes. Idempotent with
		// the settle-path finalize.
		const { chatId, jobId, steer } = setup();
		assert.equal(jobStore.getJob(jobId)!.status, "running");
		noteSteerVisible(steer);
		assert.equal(jobStore.getJob(jobId)!.status, "done", "flipped at the seam, no turn settled");
		noteSteerVisible(steer); // the settle-path flip re-runs — no-op
		assert.equal(jobStore.getJob(jobId)!.status, "done");
		// A marker with no jobId is a harmless no-op.
		noteSteerVisible({ id: "steer_probe_none", role: "custom", customType: "compaction", content: "", display: true, details: { chatId }, timestamp: 1 } as never);
	});

	it("the idle wake carries EVERY pending marker in ONE turn", async () => {
		const { chatId, steer } = setup();
		const job2 = jobStore.createJob({ kind: "research", chatId, toolCallId: "call-2" });
		trackJob(job2.id);
		const result: JobResult = { brief: "Second result." };
		jobStore.updateJob(job2.id, { result });
		const steer2 = buildSubagentSteer(job2, result);

		const fired: SteerMessage[][] = [];
		setTurnRunner(async (_cid, input) => {
			fired.push((input as SteerInput).steers as SteerMessage[]);
			return 200;
		});

		await Promise.all([deliverJobResult(steer), deliverJobResult(steer2)]);
		assert.equal(fired.length, 1, "one wake for the whole queue");
		assert.equal(fired[0]!.length, 2, "both markers ride the same turn");
		const ids = fired[0]!.map((s) => s.id).sort();
		assert.deepEqual(ids, [steer.id, steer2.id].sort());
	});
});


	it("fails the job (error status) when the wake turn errors unrecoverably", async () => {
		const { jobId, steer } = setup();
		setTurnRunner(async () => 500);

		await deliverJobResult(steer).then(
			() => assert.fail("expected delivery to reject"),
			() => undefined,
		);
		const errored = jobStore.getJob(jobId)!;
		assert.equal(errored.status, "error");
		assert.match(errored.error ?? "", /status 500/);
	});
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── persist id hygiene (the duplicate-empty-key bug) ────────────────────────

describe("persistTurn (native history, Wave B)", () => {
	it("stamps EMPTY ids (pi minted no id) at the canonical write and preserves existing ones", () => {
		const chat = chatStore.createChat("Test: persist stamps ids");
		trackChat(chat.id);
		const stamped = persistTurn(chatStore, chat.id, 0, [
			{ id: "", role: "user", content: "wake turn", timestamp: 1 } as never,
			{
				id: "msg_kept",
				role: "assistant",
				content: [{ type: "text", text: "hi" }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 1,
			} as never,
		], false);
		assert.notEqual(stamped[0]!.id, "", "empty id replaced");
		assert.match(stamped[0]!.id, /^msg_/);
		assert.equal(stamped[1]!.id, "msg_kept", "server-authored id untouched");
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.messages.length, 2, "both messages persisted");
		assert.ok(record.messages.every((m) => m.id && m.id.length > 0), "no empty ids survive persist");
	});

	it("baseCount slices the turn's own messages (the agent's state is append-only across turns)", () => {
		const chat = chatStore.createChat("Test: persist slices the turn tail");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [
			{ id: "base_1", role: "user", content: "first", timestamp: 1 } as never,
		]);
		// The agent's state at onFinish: the base record + the turn's OWN new
		// messages (Wave B: onFinish receives the full native history — the
		// slice keeps persist append-only).
		const state = [
			{ id: "base_1", role: "user", content: "first", timestamp: 1 } as never,
			{
				id: "",
				role: "assistant",
				content: [{ type: "text", text: "wake turn" }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "stop",
				timestamp: 1,
			} as never,
		];
		const stamped = persistTurn(chatStore, chat.id, 1, state, false);
		assert.equal(stamped.length, 1, "only the turn's new tail persists");
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.messages.length, 2, "the base record is untouched — append-only");
		assert.match(record.messages[1]!.id, /^msg_/);
	});

	it("drops clean question placeholders, keeps errored ones (fork 1: the record ends at the unanswered call)", () => {
		const chat = chatStore.createChat("Test: persist placeholder filtering");
		trackChat(chat.id);
		const stamped = persistTurn(chatStore, chat.id, 0, [
			{
				id: "",
				role: "assistant",
				content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "q?" } as never }],
				api: "openai-completions",
				provider: "openrouter",
				model: "test",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "toolUse",
				timestamp: 1,
			} as never,
			// The loop's synthetic "question posed" result — never a fact.
			{
				id: "",
				role: "toolResult",
				toolCallId: "q1",
				toolName: "quiz",
				content: [{ type: "text", text: "question posed" }],
				details: "question posed",
				isError: false,
				timestamp: 1,
			} as never,
			// An ERRORED authoring call DOES persist — the model's retry context.
			{
				id: "",
				role: "toolResult",
				toolCallId: "q1",
				toolName: "quiz",
				content: [{ type: "text", text: "bad options" }],
				details: "bad options",
				isError: true,
				timestamp: 1,
			} as never,
		], false);
		assert.equal(stamped.length, 2, "the clean placeholder is filtered, the errored result stays");
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.messages.length, 2);
		assert.equal((record.messages[1] as { isError: boolean }).isError, true);
	});
});

// ─── abort (2026-09 semantics: real kill, cancelled status, teacher told) ───

describe("abort (src/server/jobs.ts abortJob)", () => {
	function newChatWithJob(label: string, toolCallId: string): { chatId: string; jobId: string } {
		const chat = chatStore.createChat(`Test: ${label}`);
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, nativeToolMessages("hi", "build", toolCallId, { what: "x" }));
		const job = jobStore.createJob({ kind: "build", chatId: chat.id, toolCallId });
		trackJob(job.id);
		return { chatId: chat.id, jobId: job.id };
	}

	it("kills the running loop: error \"Aborted by learner\" immediately, the loop's signal fires, the agent gets the abort steer", async () => {
		const { jobId } = newChatWithJob("abort running job", "call-abort1");
		const fired: SteerMessage[] = [];
		setTurnRunner(async (_cid, input) => {
			fired.push(...((input as SteerInput).steers as SteerMessage[]));
			return 200;
		});
		// A live loop registers its AbortController (what a job runner does).
		const controller = new AbortController();
		registerJobAbort(jobId, controller);
		try {
			const outcome = abortJob(jobId);
			assert.ok(outcome.ok);
			assert.equal(controller.signal.aborted, true, "the real kill: the loop's signal fired");
			const killed = jobStore.getJob(jobId)!;
			assert.equal(killed.status, "error", "flipped synchronously — the poll sees it at once");
			assert.equal(killed.error, "Aborted by learner", "abort reads as an error with a reason, not a failure");
			assert.equal(killed.activity, "aborted");
			assert.equal(killed.result, undefined, "no result on an aborted job");

			await waitFor(() => fired.length > 0, 8000, "abort wake fired");
			const last = fired[0]!;
			assert.equal((last.details as { aborted: boolean }).aborted, true);
			assert.equal(last.id, `steer_${jobId}`);
			assert.equal(last.customType, "subagent-abort", "the abort marker — no artifact");
			// aborted is terminal: the wake completing must not flip it
			assert.equal(jobStore.getJob(jobId)!.status, "error", "terminal after the wake");
		} finally {
			unregisterJobAbort(jobId);
		}
	});

	it("aborting a delivering job drops the queued result steer and wakes with the abort note instead", async () => {
		const chat = chatStore.createChat("Test: abort delivering job");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never]);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-abort3" });
		trackJob(job.id);
		const result: JobResult = { brief: "Done: it works." };
		jobStore.updateJob(job.id, { result, activity: "delivering result" });

		// Block the pump's idle gates so the result steer sits QUEUED, not in flight.
		assert.ok(beginTurn(chat.id));
		const fired: SteerMessage[] = [];
		setTurnRunner(async (_cid, input) => {
			fired.push(...((input as SteerInput).steers as SteerMessage[]));
			return 200;
		});
		void deliverJobResult(buildSubagentSteer(job, result)).catch(() => {
			/* dropped by the abort below */
		});
		await waitFor(() => jobStore.getJob(job.id)!.activity === "delivering result", 8000, "queued");

		const outcome = abortJob(job.id);
		assert.ok(outcome.ok);
		assert.equal(jobStore.getJob(job.id)!.status, "error");
		assert.equal(jobStore.getJob(job.id)!.error, "Aborted by learner");

		endTurn(chat.id); // gates open — whatever is left in the queue fires
		await waitFor(() => fired.length > 0, 8000, "wake fired");
		assert.equal(fired.length, 1, "exactly one delivery — the result steer was dropped");
		assert.equal((fired[0]!.details as { aborted: boolean }).aborted, true, "the abort steer, not the result");
		assert.equal(jobStore.getJob(job.id)!.status, "error", "terminal after the wake");
	});

	it("outcome reasons: not_found for unknown, not_running for settled jobs", () => {
		assert.deepEqual(abortJob("job_does_not_exist"), { ok: false, reason: "not_found" });
		const chat = chatStore.createChat("Test: abort settled job");
		trackChat(chat.id);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: "call-abort4" });
		trackJob(job.id);
		jobStore.updateJob(job.id, { status: "done", activity: "delivered" });
		assert.deepEqual(abortJob(job.id), { ok: false, reason: "not_running" });
	});
});

// ─── 7. crash recovery, LIVENESS-GATED (observability-accuracy wave, 2026-09-19) ──
//
// The sweep (recoverStaleJobs) keys on the abort registry (subagents/aborts.ts
// isJobLive), not record age: a "running" record with a live registration
// belongs to a loop executing in THIS process (hung or slow — never re-run
// beside itself); without one it is a process-death orphan and recovers at
// once. The old 15-minute STALE_JOB_MS heuristic is gone — these tests prove
// immediacy by running the sweep on FRESH records.

describe("stale-job recovery sweep (liveness-gated)", () => {
	/** Reset the sweep's 30s throttle — tests fire it directly, repeatedly. */
	function resetSweepThrottle(): void {
		const g = globalThis as { __lhWakePipeline?: { lastSweepAt: number } };
		if (g.__lhWakePipeline) g.__lhWakePipeline.lastSweepAt = 0;
	}

	/** A FRESH "running" record (no loop registration): the orphan shape.
	 *  Freshness is the point — the old code needed 15 minutes of age. */
	function orphanJob(withResult?: JobResult): { chatId: string; jobId: string } {
		const chat = chatStore.createChat("Test: stale sweep");
		trackChat(chat.id);
		chatStore.saveMessages(chat.id, [{ id: "u1", role: "user", content: "hello", timestamp: 1 } as never]);
		const job = jobStore.createJob({ kind: "research", chatId: chat.id, toolCallId: `call-sweep-${createdJobs.length}` });
		trackJob(job.id);
		if (withResult) jobStore.updateJob(job.id, { result: withResult, activity: "delivering result" });
		return { chatId: chat.id, jobId: job.id };
	}

	it("a running record with a LIVE loop registration is never recovered — however old (the double-run guard)", () => {
		const { jobId } = orphanJob();
		// Backdate the record well past every plausible in-flight run: age
		// alone must NOT trigger recovery anymore.
		jobStore.updateJob(jobId, { updatedAt: new Date(Date.now() - 30 * 60_000).toISOString() });
		registerJobAbort(jobId, new AbortController()); // a loop is executing
		// JURISDICTIONAL (owner round 8, 2026-10-05): the sweep scans the
		// SHARED jobs dir — under the full suite, OTHER FILES' processes
		// legitimately leave running records this sweep may respawn. Only
		// THIS test's job is this test's business: collect ids, assert ours
		// never respawns (the counter form saw foreign respawns as failures).
		const respawnedIds: string[] = [];
		setJobRespawn((id) => {
			respawnedIds.push(id);
		});
		resetSweepThrottle();
		recoverStaleJobs();
		assert.ok(!respawnedIds.includes(jobId), "a live loop is provably executing — no respawn beside it");
		assert.equal(jobStore.getJob(jobId)!.activity, "starting", "the record is untouched");
		// Hermetic teardown: settle + unregister so later sweeps in THIS suite
		// never see this fixture as a fresh orphan.
		jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
		unregisterJobAbort(jobId);
	});

	it("a running record WITHOUT a registration is an orphan: the loop is re-spawned immediately (no age wait)", () => {
		const { jobId } = orphanJob();
		// JURISDICTIONAL (see above): foreign respawns may interleave under
		// the full suite — ours must be among them, at once.
		const respawnedIds: string[] = [];
		setJobRespawn((id) => {
			respawnedIds.push(id);
		});
		resetSweepThrottle();
		recoverStaleJobs();
		assert.ok(respawnedIds.includes(jobId), "the orphan's loop is re-spawned at once");
		assert.equal(jobStore.getJob(jobId)!.activity, "recovering: re-running");
		// Hermetic teardown (see above) — the respawned loop is the TEST's
		// fake seam, nothing real runs.
		jobStore.updateJob(jobId, { status: "done", activity: "settled (test)" });
	});

	it("an orphan WITH a stored result is re-delivered: the wake fires and the job flips done", async () => {
		const { jobId } = orphanJob({ brief: "Done: it works.", sources: [] });
		let fired = 0;
		setTurnRunner(async () => {
			fired++;
			return 200;
		});
		resetSweepThrottle();
		recoverStaleJobs();
		await waitFor(() => fired > 0, 8000, "recovery wake fired");
		await waitFor(() => jobStore.getJob(jobId)!.status !== "running", 8000, "orphan settled after re-delivery");
		assert.equal(jobStore.getJob(jobId)!.status, "done");
	});
});

// ─── composer steering (owner arc 2026-10-03): the user-steer registry ──────

describe("composer steering: steerLiveChat + the deliver-or-requeue lifecycle", () => {
	/** A minimal stand-in for pi's Agent — only steer() is touched. */
	function fakeAgent(): { handed: unknown[]; agent: unknown } {
		const handed: unknown[] = [];
		return { handed, agent: { steer: (m: unknown) => handed.push(m) } };
	}

	it("no live turn → false, nothing parked (the client falls back to a plain send)", () => {
		const chatId = chatStore.createChat("steer: idle").id;
		const msg = { id: "steer_x1", role: "user", content: "hold on", timestamp: 1 };
		assert.equal(steerLiveChat(chatId, msg as never), false);
		const { handed, agent } = fakeAgent();
		registerLiveAgent(chatId, agent as never); // a later run hands NOTHING
		assert.equal(handed.length, 0, "nothing was parked by the refused steer");
		unregisterLiveAgent(chatId);
	});

	it("live agent → steered AND parked (the stranding safety net)", () => {
		const chatId = chatStore.createChat("steer: live").id;
		const msg = { id: "steer_x2", role: "user", content: "also cover Venus", timestamp: 1 };
		const { handed, agent } = fakeAgent();
		registerLiveAgent(chatId, agent as never);
		assert.equal(steerLiveChat(chatId, msg as never), true);
		assert.equal(handed.length, 1, "handed to the live agent's steering queue");
		// Re-registering the SAME agent never re-hands (double-handoff guard).
		registerLiveAgent(chatId, agent as never);
		assert.equal(handed.length, 1);
		unregisterLiveAgent(chatId);
	});

	it("settlement reconciliation: delivered ids drop, stranded ones ride the NEXT run", () => {
		const chatId = chatStore.createChat("steer: reconcile").id;
		const delivered = { id: "steer_d1", role: "user", content: "delivered", timestamp: 1 };
		const stranded = { id: "steer_s1", role: "user", content: "stranded behind a question", timestamp: 2 };
		const { handed, agent } = fakeAgent();
		registerLiveAgent(chatId, agent as never);
		assert.equal(steerLiveChat(chatId, delivered as never), true);
		assert.equal(steerLiveChat(chatId, stranded as never), true);

		// Settlement: the run persisted ONLY the delivered one (the stranded
		// copy died with the agent — question termination / abort).
		unregisterLiveAgent(chatId);
		reconcileUserSteers(chatId, [delivered] as never);

		// The chat's next run (the answer turn) picks up the stranded steer.
		const next = fakeAgent();
		registerLiveAgent(chatId, next.agent as never);
		assert.equal(next.handed.length, 1, "exactly the stranded steer rides the next run");
		assert.deepEqual((next.handed[0] as { id: string }).id, "steer_s1");
		unregisterLiveAgent(chatId);
		reconcileUserSteers(chatId, [stranded, delivered] as never); // cleanup
	});
});
