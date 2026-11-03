/** The answer-card handler of the thread API, driven against the @wolfpack/client mock (which raises no cards). */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockConsoleClient } from "@wolfpack/client";
import { createThreadApi } from "../src/server/thread-api.ts";

const ref = { wolf: "1uk4", slug: "home" };
const post = (body: unknown) => new Request("http://t/answer", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

describe("thread API: answerCard", () => {
	const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));

	it("400 when the body has no answers", async () => {
		assert.equal((await api.answerCard(ref, "c1", post({ nope: 1 }))).status, 400);
		assert.equal((await api.answerCard(ref, "c1", post("not json"))).status, 400);
	});

	it("404 for an unknown card", async () => {
		assert.equal((await api.answerCard(ref, "c1", post({ answers: { answer: { value: "x" } } }))).status, 404);
	});
});

describe("thread API: skipCard", () => {
	const api = createThreadApi(() => new MockConsoleClient({ delayMs: 0 }));

	it("404 for an unknown card", async () => {
		assert.equal((await api.skipCard(ref, "c1")).status, 404);
	});
});

describe("thread API: card answers while a turn runs", () => {
	/** A client whose card routes ack a steer, as wolfd does mid-turn. */
	const steering = () => {
		const base = new MockConsoleClient({ delayMs: 0 });
		return Object.assign(base, {
			answerCard: async () => ({ messageId: "9", disposition: "steered" as const }),
			skipCard: async () => ({ messageId: "9", disposition: "steered" as const }),
		});
	};

	it("passes a steered ack through as 200 (not a 409 busy)", async () => {
		const api = createThreadApi(() => steering());
		const res = await api.answerCard(ref, "c1", post({ answers: { answer: { value: "x" } } }));
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { messageId: "9", disposition: "steered" });
		const skip = await api.skipCard(ref, "c1");
		assert.equal(skip.status, 200);
		assert.equal(((await skip.json()) as { disposition: string }).disposition, "steered");
	});

	it("a card superseded mid-turn is still 404", async () => {
		const gone = Object.assign(new MockConsoleClient({ delayMs: 0 }), {
			answerCard: async () => {
				throw Object.assign(new Error("card c1"), { name: "NotFoundError" });
			},
		});
		const api = createThreadApi(() => gone);
		assert.equal((await api.answerCard(ref, "c1", post({ answers: { answer: { value: "x" } } }))).status, 404);
	});
});
