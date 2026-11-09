/**
 * Fixture for tests/jobs-idle-reset.test.ts (not collected: not *.test.ts). Parks a wake pump behind a dangling
 * quiz, as tests/jobs.test.ts does, then runs only the shared reset (what the suite's afterEach calls) and lets the
 * process end. If the pump's waitForIdle loop survives the reset, the process never exits.
 */
import { buildSubagentSteer } from "../../src/core/contracts.ts";
import { deliverJobResult, resetWakePipelineForTests, setTurnRunner } from "../../src/server/jobs.ts";
import { chatStore } from "../../src/store/chats.ts";
import { jobStore } from "../../src/store/jobs.ts";

process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";
const chat = chatStore.createChat("Test: dangling quiz fixture");
console.log(`chat:${chat.id}`); // the test deletes it; the fixture deliberately does not clean up
{
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "teach me", timestamp: 1 } as never,
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
	const job = jobStore.createJob({ kind: "build", chatId: chat.id, toolCallId: "call-fixture" });
	const result = { brief: "Done." };
	jobStore.updateJob(job.id, { result, activity: "delivering result" });
	setTurnRunner(async () => 200);
	void deliverJobResult(buildSubagentSteer(job, result));
	await new Promise((r) => setTimeout(r, 300)); // the pump is parked behind the quiz
	resetWakePipelineForTests();
}
