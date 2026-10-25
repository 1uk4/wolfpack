import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionModel } from "../components/session-core.ts";
import { threadTransport } from "../components/thread-transport.ts";
import { enterAction } from "../components/composer.tsx";

describe("thread steer", () => {
	it("enterAction while busy with text sends (steer), empty stops", () => {
		assert.equal(enterAction({ busy: true, canSend: true }), "send");
		assert.equal(enterAction({ busy: true, canSend: false }), "stop");
	});

	it("submitBody: reject when idle, steer when asked", () => {
		const t = threadTransport("w", "s");
		const input = { type: "text", text: "hi" } as const;
		assert.equal(JSON.parse(t.submitBody(input)).whenBusy, "reject");
		assert.equal(JSON.parse(t.submitBody(input, { whenBusy: "steer" })).whenBusy, "steer");
	});

	it("steer() posts whenBusy steer and echoes a user message without flipping status", async () => {
		const calls: { url: string; body: string }[] = [];
		const model = new SessionModel({
			chatId: "c",
			initialMessages: [],
			transport: threadTransport("w", "s"),
			fetch: async (url, init) => {
				calls.push({ url: String(url), body: String(init?.body) });
				return new Response("{}", { status: 200 });
			},
		} as ConstructorParameters<typeof SessionModel>[0]);
		await model.steer("go left");
		assert.equal(calls.length, 1);
		assert.match(calls[0]!.url, /\/submit$/);
		assert.equal(JSON.parse(calls[0]!.body).whenBusy, "steer");
		assert.equal(JSON.parse(calls[0]!.body).input, "go left");
		const s = model.getState();
		assert.equal(s.messages.filter((m) => m.role === "user").length, 1);
		assert.equal(s.status, "ready");
		assert.equal(s.steerQueue.length, 0);
	});
});
