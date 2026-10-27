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
