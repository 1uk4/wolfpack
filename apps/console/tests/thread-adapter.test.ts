/**
 * The thread adapter against the @wolfpack/client mock: the scripted turn's
 * ThreadEvents → the session model's wire events → the projected view.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MockConsoleClient, FIXTURE_THREAD, type ThreadEvent } from "@wolfpack/client";
import { SessionModel } from "../components/session-core.ts";
import { threadTransport } from "../components/thread-transport.ts";
import {
	resolveThreadId,
	threadHref,
	threadListItem,
	threadMessagesToNative,
	threadSlug,
	ThreadEventAdapter,
	type WireEvent,
} from "../src/core/index.ts";
import { threadFetch } from "./helpers/thread-fetch.ts";

const THREAD = FIXTURE_THREAD.id;

async function scriptedTurn(): Promise<{ client: MockConsoleClient; events: ThreadEvent[] }> {
	const client = new MockConsoleClient({ delayMs: 0 });
	await client.submit(THREAD, "hello");
	const events: ThreadEvent[] = [];
	for await (const ev of client.watch(THREAD)) events.push(ev);
	return { client, events };
}

function fold(events: readonly ThreadEvent[]): WireEvent[] {
	const adapter = new ThreadEventAdapter();
	return events.flatMap((ev) => adapter.apply(ev));
}

const blocks = (e: WireEvent) =>
	((e.message as { content: Array<{ type: string; text?: string; thinking?: string; name?: string }> }).content);

describe("ThreadEventAdapter: the scripted turn", () => {
	it("maps the full turn to pi's step shape, in order", async () => {
		const { events } = await scriptedTurn();
		assert.deepEqual(
			fold(events).map((e) => e.type),
			[
				"agent_start",
				"message_start", // thinking opens the step's message
				"message_update", // + thinking
				"message_update", // + text
				"message_update", // + text
				"message_update", // + toolCall
				"tool_execution_end",
				"message_end", // the tool call closes step 1…
				"turn_end", // …with its results batch
				"message_start", // step 2: text only
				"message_update",
				"message_end",
				"turn_end",
				"agent_end",
			],
		);
	});

	it("emits FULL partials (merged deltas), never deltas", async () => {
		const { events } = await scriptedTurn();
		const wire = fold(events);
		const lastOfStep1 = wire.filter((e) => e.type === "message_update")[3]!;
		assert.deepEqual(
			blocks(lastOfStep1).map((b) => b.type),
			["thinking", "text", "toolCall"],
		);
		assert.equal(blocks(lastOfStep1)[0]!.thinking, "The user wants me to look at a file. I should read it before answering.");
		assert.equal(blocks(lastOfStep1)[1]!.text, "Let me take a look at that file.");
		assert.equal(blocks(lastOfStep1)[2]!.name, "read");
		const step2 = wire.filter((e) => e.type === "message_end")[1]!;
		assert.equal(blocks(step2)[0]!.text, "It describes a pack of durable agents.");
		assert.equal((step2.message as { stopReason: string }).stopReason, "stop");
	});

	it("carries the tool result in the execution and the results batch", async () => {
		const { events } = await scriptedTurn();
		const wire = fold(events);
		const exec = wire.find((e) => e.type === "tool_execution_end")!;
		assert.equal(exec.isError, false);
		assert.equal((exec.result as { details: string }).details, "# Wolfpack\nA pack of durable agents.\n");
		const batch = wire.find((e) => e.type === "turn_end")!.toolResults as Array<{ toolCallId: string; toolName: string }>;
		assert.equal(batch.length, 1);
		assert.equal(batch[0]!.toolName, "read");
		assert.equal(batch[0]!.toolCallId, exec.toolCallId);
	});

	it("marks aborted and errored turns on the closing message", () => {
		const base = { threadId: "t", at: "2026-01-01T00:00:00.000Z" };
		const aborted = fold([
			{ ...base, id: 1, type: "turn-start", turnId: "a" },
			{ ...base, id: 2, type: "text-delta", turnId: "a", text: "par" },
			{ ...base, id: 3, type: "turn-end", turnId: "a", reason: "aborted" },
		]);
		assert.equal((aborted.find((e) => e.type === "message_end")!.message as { stopReason: string }).stopReason, "aborted");
		const errored = fold([
			{ ...base, id: 1, type: "turn-start", turnId: "a" },
			{ ...base, id: 2, type: "text-delta", turnId: "a", text: "par" },
			{ ...base, id: 3, type: "error", turnId: "a", message: "boom" },
			{ ...base, id: 4, type: "turn-end", turnId: "a", reason: "error" },
		]);
		assert.deepEqual(errored.find((e) => e.type === "error"), { type: "error", errorText: "boom" });
		const end = errored.find((e) => e.type === "message_end")!.message as { stopReason: string; errorMessage: string };
		assert.equal(end.stopReason, "error");
		assert.equal(end.errorMessage, "boom");
	});
});

describe("ThreadEventAdapter: resume from an event id", () => {
	it("tolerates starting at ANY event id and still terminates cleanly", async () => {
		const { events } = await scriptedTurn();
		for (const cut of events) {
			const tail = events.filter((e) => e.id > cut.id);
			const wire = fold(tail);
			if (tail.length === 0) continue;
			assert.equal(wire.at(-1)!.type, "agent_end", `resume after #${cut.id}`);
		}
	});

	it("opens a message on the first delta it sees (mid-step resume)", async () => {
		const { events } = await scriptedTurn();
		const afterFirstText = events.filter((e) => e.id > events.find((x) => x.type === "text-delta")!.id);
		const first = fold(afterFirstText).find((e) => e.type.startsWith("message_"))!;
		assert.equal(first.type, "message_start");
		assert.equal(blocks(first)[0]!.text, "at that file.");
	});

	it("resuming after the tool ended yields only the closing step", async () => {
		const { events } = await scriptedTurn();
		const toolEnd = events.find((e) => e.type === "tool-end")!;
		const wire = fold(events.filter((e) => e.id > toolEnd.id));
		assert.deepEqual(
			wire.map((e) => e.type),
			["message_start", "message_update", "message_end", "turn_end", "agent_end"],
		);
	});

	it("a tool-end whose start was missed still yields its execution", async () => {
		const { events } = await scriptedTurn();
		const toolEnd = events.find((e) => e.type === "tool-end")!;
		const wire = fold(events.filter((e) => e.id >= toolEnd.id));
		assert.equal(wire[0]!.type, "tool_execution_end");
	});

	it("a replay from the turn's start reproduces the uninterrupted fold", async () => {
		const { client, events } = await scriptedTurn();
		const replay: ThreadEvent[] = [];
		for await (const ev of client.watch(THREAD, { from: 0 })) replay.push(ev);
		assert.deepEqual(
			fold(replay).map((e) => e.type),
			fold(events).map((e) => e.type),
		);
	});
});

describe("session model over the thread transport (mock client end to end)", () => {
	it("send → submit → watch renders the scripted turn, settling ready", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		const model = new SessionModel({
			chatId: THREAD,
			initialMessages: [],
			transport: threadTransport("1uk4", "home"),
			fetch: threadFetch(client),
		});
		await model.send({ type: "text", text: "read the readme" });
		const state = model.getState();
		assert.equal(state.status, "ready");
		assert.equal(state.error, null);
		const [user, assistant] = state.messages;
		assert.equal(user!.role, "user");
		assert.equal(user!.parts[0]!.text, "read the readme");
		assert.equal(assistant!.role, "assistant");
		assert.deepEqual(
			assistant!.parts.map((p) => p.type),
			["step-start", "reasoning", "text", "tool-read", "step-start", "text"],
		);
		const tool = assistant!.parts.find((p) => p.type === "tool-read")!;
		assert.equal(tool.state, "output-available");
		assert.deepEqual(tool.input, { path: "README.md" });
		assert.equal(tool.output, "# Wolfpack\nA pack of durable agents.\n");
	});

	it("renders a tool call as input-streaming until its tool-end lands", async () => {
		const client = new MockConsoleClient({ delayMs: 0 });
		await client.submit(THREAD, "go");
		const all: ThreadEvent[] = [];
		for await (const ev of client.watch(THREAD)) all.push(ev);
		const enc = new TextEncoder();
		const frame = (ev: ThreadEvent) => enc.encode(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
		const model = new SessionModel({
			chatId: THREAD,
			initialMessages: [],
			transport: threadTransport("1uk4", "home"),
			fetch: (async () => new Response(body)) as typeof fetch,
		});
		const done = model.resumeStream(false);
		const tick = () => new Promise((r) => setTimeout(r, 5));
		const toolPart = () =>
			model.getState().messages.flatMap((m) => m.parts).find((p) => p.type === "tool-read");

		for (const ev of all.filter((e) => e.type !== "tool-end" && e.type !== "turn-end" && e.id <= all.find((x) => x.type === "tool-update")!.id)) {
			controller.enqueue(frame(ev));
		}
		await tick();
		assert.equal(model.status, "streaming");
		assert.equal(toolPart()!.state, "input-streaming");

		controller.enqueue(frame(all.find((e) => e.type === "tool-end")!));
		await tick();
		assert.equal(toolPart()!.state, "output-available");

		controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
		controller.close();
		await done;
		assert.equal(model.status, "ready");
	});

	it("renders a failed tool as output-error", () => {
		const base = { threadId: "t", at: "2026-01-01T00:00:00.000Z", turnId: "a" };
		const model = new SessionModel({ chatId: "t", initialMessages: [], transport: threadTransport("w", "t") });
		const wire = threadTransport("w", "t").createWire();
		const events: ThreadEvent[] = [
			{ ...base, id: 1, type: "tool-start", callId: "c1", name: "read", args: { path: "x" } },
			{ ...base, id: 2, type: "tool-end", callId: "c1", result: "ENOENT", isError: true },
		];
		for (const ev of events) for (const w of wire(ev as never)) model.applyWireEvent(w);
		const part = model.getState().nativeMessages;
		assert.ok(part.length >= 2);
		// settled (not in flight) view: the result pairs onto the call
		const view = model.getState().messages.flatMap((m) => m.parts).find((p) => p.type === "tool-read")!;
		assert.equal(view.state, "output-error");
		assert.equal(view.errorText, "ENOENT");
	});

	it("resumes an in-flight turn: reattach with no from replays the turn onto a clean slate", async () => {
		const client = new MockConsoleClient({ delayMs: 5 });
		await client.submit(THREAD, "go");
		await new Promise((r) => setTimeout(r, 30)); // mid-turn
		const model = new SessionModel({
			chatId: THREAD,
			initialMessages: threadMessagesToNative((await client.getThread(THREAD)).messages),
			transport: threadTransport("1uk4", "home"),
			fetch: threadFetch(client),
		});
		await model.resumeStream(false);
		const assistant = model.getState().messages.find((m) => m.role === "assistant")!;
		assert.ok(assistant.parts.some((p) => p.type === "tool-read" && p.state === "output-available"));
		assert.equal(model.status, "ready");
	});

	it("surfaces a busy submit as an error (no polling)", async () => {
		const client = new MockConsoleClient({ delayMs: 20 });
		await client.submit(THREAD, "first");
		const model = new SessionModel({
			chatId: THREAD,
			initialMessages: [],
			transport: threadTransport("1uk4", "home"),
			fetch: threadFetch(client),
		});
		await model.send({ type: "text", text: "second" });
		assert.equal(model.status, "error");
		assert.match(model.getState().error!.message, /already running/);
		await client.abort(THREAD);
	});
});

describe("history + routing helpers", () => {
	it("threadMessagesToNative keeps ids, roles and text", () => {
		const native = threadMessagesToNative([
			{ id: "m1", role: "user", text: "hi", at: "2026-01-01T00:00:00.000Z" },
			{ id: "m2", role: "assistant", text: "yo", at: "2026-01-01T00:00:01.000Z" },
		]);
		assert.deepEqual(native.map((m) => [m.id, (m as { role: string }).role]), [["m1", "user"], ["m2", "assistant"]]);
		assert.equal((native[0] as { content: string }).content, "hi");
		assert.deepEqual((native[1] as { content: unknown }).content, [{ type: "text", text: "yo" }]);
	});

	it("slugs strip the wolf prefix and resolve back to the client id", () => {
		assert.equal(threadSlug("1uk4", "1uk4/home"), "home");
		assert.equal(threadSlug("1uk4", "other"), "other");
		assert.equal(threadHref("1uk4", "1uk4/home"), "/wolf/1uk4/thread/home");
		assert.equal(resolveThreadId("1uk4", "home", [{ id: "1uk4/home" }]), "1uk4/home");
		assert.equal(resolveThreadId("1uk4", "nope", [{ id: "1uk4/home" }]), null);
		assert.equal(threadListItem("1uk4", { id: "1uk4/home", title: "Home" }).href, "/wolf/1uk4/thread/home");
	});
});

describe("ThreadEventAdapter: snapshot frames", () => {
	const at = "2026-01-01T00:00:00.000Z";
	const env = { threadId: THREAD, at, actor: { id: "w", kind: "wolf" as const } };
	const snapshot = (text: string, thinking?: string) =>
		({
			...env, id: 9, type: "snapshot", upToId: 9,
			inFlight: { turnId: "t", text, ...(thinking ? { thinking } : {}) },
			thread: { id: THREAD, wolf: "w", kind: "home", title: "t", busy: true, lastEventId: 9, messages: [] },
		}) as never;

	it("replaces the stale in-flight text with the snapshot's", () => {
		const a = new ThreadEventAdapter();
		a.apply({ ...env, id: 1, type: "turn-start", turnId: "t" } as ThreadEvent);
		a.apply({ ...env, id: 2, type: "text-delta", turnId: "t", text: "stale" } as ThreadEvent);
		const u = a.apply(snapshot("HEAD-full text"));
		assert.equal(u[0]!.type, "message_update");
		assert.equal(blocks(u[0]!)[0]?.text, "HEAD-full text");
		const out = a.apply({ ...env, id: 3, type: "turn-end", turnId: "t", reason: "complete" } as ThreadEvent);
		assert.equal(blocks(out.find((e) => e.type === "message_end")!)[0]?.text, "HEAD-full text");
	});

	it("is relative to messages the turn already closed", () => {
		const a = new ThreadEventAdapter();
		a.apply({ ...env, id: 1, type: "turn-start", turnId: "t" } as ThreadEvent);
		a.apply({ ...env, id: 2, type: "text-delta", turnId: "t", text: "step one. " } as ThreadEvent);
		a.apply({ ...env, id: 3, type: "tool-start", turnId: "t", callId: "c", name: "x", args: {} } as ThreadEvent);
		a.apply({ ...env, id: 4, type: "tool-end", turnId: "t", callId: "c", result: "r", isError: false } as ThreadEvent);
		a.apply({ ...env, id: 5, type: "text-delta", turnId: "t", text: "bad" } as ThreadEvent);
		const u = a.apply(snapshot("step one. step two"));
		assert.equal(blocks(u[0]!)[0]?.text, "step two");
	});

	it("ignores a snapshot without an in-flight turn", () => {
		const a = new ThreadEventAdapter();
		const s = snapshot("x") as { inFlight?: unknown };
		delete s.inFlight;
		assert.deepEqual(a.apply(s as never), []);
	});
});
