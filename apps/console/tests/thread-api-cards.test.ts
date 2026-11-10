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

describe("thread API: paged ask routes", () => {
	const paged = (over: object) => createThreadApi(() => Object.assign(new MockConsoleClient({ delayMs: 0 }), over));

	it("answerCardPage rejects a bad page number and a missing answers object", async () => {
		const api = paged({ answerCardPage: async () => ({ ok: true }) });
		assert.equal((await api.answerCardPage(ref, "c1", "-1", post({ answers: {} }))).status, 400);
		assert.equal((await api.answerCardPage(ref, "c1", "x", post({ answers: {} }))).status, 400);
		assert.equal((await api.answerCardPage(ref, "c1", "0", post({ answers: [] }))).status, 400);
		assert.equal((await api.answerCardPage(ref, "c1", "0", post({}))).status, 400);
		assert.equal((await api.answerCardPage(ref, "c1", "0", post({ answers: {} }))).status, 200);
	});

	it("a conflict from the wolf is a 409 with code conflict", async () => {
		const api = paged({ answerCardPage: async () => { throw Object.assign(new Error("page moved"), { name: "ProtocolError", code: "conflict" }); } });
		const res = await api.answerCardPage(ref, "c1", "0", post({ answers: {} }));
		assert.equal(res.status, 409);
		assert.equal(((await res.json()) as { code: string }).code, "conflict");
	});

	it("bindCardText rejects blank or non-string text and accepts real text", async () => {
		const api = paged({ bindCardText: async () => undefined });
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ text: "  " }))).status, 400);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ text: 3 }))).status, 400);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ text: "because" }))).status, 200);
	});
});

describe("thread API: bindCardText attachments", () => {
	it("passes attachment ids through, allows images without text, and refuses neither or a bad list", async () => {
		const seen: unknown[][] = [];
		const api = createThreadApi(() => Object.assign(new MockConsoleClient({ delayMs: 0 }), { bindCardText: async (_t: string, _c: string, _q: string, text: string, att?: string[]) => void seen.push([text, att]) }));
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ text: "why", attachments: ["a1"] }))).status, 200);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ attachments: ["a1", "a2"] }))).status, 200);
		assert.deepEqual(seen, [["why", ["a1"]], ["", ["a1", "a2"]]]);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ text: " ", attachments: [] }))).status, 400);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ text: "x", attachments: [3] }))).status, 400);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ text: "x", attachments: "a1" }))).status, 400);
	});
});

describe("thread API: bindCardText custom answers", () => {
	it("passes a multi question's picked and custom lists through, and refuses malformed lists", async () => {
		const seen: unknown[] = [];
		const api = createThreadApi(() => Object.assign(new MockConsoleClient({ delayMs: 0 }), { bindCardText: async (_t: string, _c: string, _q: string, _text: string, _att?: string[], multi?: unknown) => void seen.push(multi) }));
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ picked: ["a"], others: ["red", "blue"] }))).status, 200);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ picked: ["a"], others: [] }))).status, 200);
		assert.deepEqual(seen, [{ picked: ["a"], others: ["red", "blue"] }, { picked: ["a"], others: [] }]);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ picked: ["a"], others: "red" }))).status, 400);
		assert.equal((await api.bindCardText(ref, "c1", "q1", post({ picked: [3], others: [] }))).status, 400);
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
