/**
 * The console's REAL server side against a REAL wolfd (startTestWolf): a steer-started parent turn (a sub-agent's result
 * arriving as the parent's input, nobody submitted it) must reach /api/events as needs-you-changed {kind: "status"}.
 * Nothing here calls /api/needs-you: opening the events channel alone has to get the activity followed.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseStep } from "../../../packages/harness/dist/wolfd/scripted-model.js";
import { startTestWolf, type TestWolf } from "../../../packages/harness/dist/wolfd/test-wolf.js";
import { activityBridge } from "../src/server/needs-you-api.ts";
import { setConsoleClient } from "../src/server/console-client.ts";
import { eventsResponse } from "../src/server/events-stream.ts";

let tw: TestWolf | undefined;
const aborts: AbortController[] = [];
afterEach(async () => {
	activityBridge().stop();
	(globalThis as Record<symbol, unknown>)[Symbol.for("wolfpack.console.activityBridge")] = undefined;
	for (const a of aborts.splice(0)) a.abort();
	setConsoleClient(undefined);
	await tw?.stop();
	tw = undefined;
});

const PROFILE = "---\nname: tester\ndescription: A scripted test agent\nmodel: fast\ntools: read, grep\n---\n\nYou are a test agent.\n";

/** Parent: spawns on "spawn:", otherwise acks. Child: holds a SLOW brief until the gate opens. */
function agents(gate: Promise<void>): FauxResponseStep {
	return async (ctx, options) => {
		const child = JSON.stringify(ctx.messages.filter((m) => m.role === "system")).includes("You are the sub-agent");
		const last = ctx.messages[ctx.messages.length - 1];
		const text = typeof last.content === "string" ? last.content : (last.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
		if (!child) {
			if (last.role === "toolResult") return fauxAssistantMessage("spawned");
			if (text.startsWith("spawn:")) return fauxAssistantMessage(fauxToolCall("subagent", { agent: "tester", task: "SLOW work", name: "tester" }), { stopReason: "toolUse" });
			return fauxAssistantMessage("parent saw the result");
		}
		await Promise.race([gate, new Promise<void>((r) => options?.signal?.addEventListener("abort", () => r()))]);
		return fauxAssistantMessage("CHILD_RESULT");
	};
}

/** Read the console's /api/events response, collecting `needs-you-changed` payloads. */
function collect(): { events: Array<Record<string, unknown>>; opened: Promise<void> } {
	const ctl = new AbortController();
	aborts.push(ctl);
	const res = eventsResponse();
	const reader = res.body!.getReader();
	const events: Array<Record<string, unknown>> = [];
	let open!: () => void;
	const opened = new Promise<void>((r) => (open = r));
	void (async () => {
		const dec = new TextDecoder();
		let buf = "";
		ctl.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}));
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buf += dec.decode(value);
			for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
				const frame = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (frame.startsWith(": connected")) open();
				const m = /^event: (\S+)\ndata: (.*)$/s.exec(frame);
				if (m && m[1] === "needs-you-changed") events.push(JSON.parse(m[2]!));
			}
		}
	})().catch(() => {});
	return { events, opened };
}

const until = async (fn: () => boolean, ms = 8000) => {
	const end = Date.now() + ms;
	while (!fn()) {
		if (Date.now() > end) assert.fail("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
};

describe("console /api/events against a real wolfd", () => {
	it("announces a steer-started parent turn as busy, with no /api/needs-you call", async () => {
		let open!: () => void;
		const gate = new Promise<void>((r) => (open = r));
		const step = agents(gate);
		tw = await startTestWolf({ script: Array.from({ length: 40 }, () => step) });
		const dir = join(tw.root, "agent", "agents");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "tester.md"), PROFILE);
		setConsoleClient(tw.client);

		const { events, opened } = collect();
		await opened;
		const statuses = () => events.filter((e) => e.kind === "status" && e.threadId === tw!.home).map((e) => e.status);

		await tw.client.submit(tw.home, "spawn: x", { whenBusy: "reject" });
		await until(() => statuses().at(-1) === "idle");
		const busyBefore = statuses().filter((s) => s === "busy").length;

		// the child finishes later: its result starts a parent turn that nobody submitted
		open();
		await until(() => statuses().filter((s) => s === "busy").length === busyBefore + 1);
		await until(() => statuses().at(-1) === "idle");
	});
});
