/**
 * Render keys: every tool row in a message must have a unique callId key
 * (React logs "two children with the same key" otherwise). Live, history, and
 * live-over-history (a reattach replay on top of a record that already holds
 * the same calls) all project to unique keys.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ThreadEvent, ThreadMessage } from "@wolfpack/client";
import { SessionModel } from "../components/session-core.ts";
import { threadTransport } from "../components/thread-transport.ts";
import { renderItems, threadMessagesToNative } from "../src/core/index.ts";

const base = { threadId: "t", at: "2026-01-01T00:00:00.000Z", turnId: "a" };
let n = 0;
const ev = (e: Record<string, unknown>) => ({ ...base, id: ++n, ...e }) as unknown as ThreadEvent;

/** A parallel batch of three calls, a text step, then one more call. */
const events = (): ThreadEvent[] => [
	ev({ type: "turn-start" }),
	ev({ type: "tool-start", callId: "a", name: "bash", args: { command: "ls" } }),
	ev({ type: "tool-start", callId: "b", name: "read", args: { path: "x" } }),
	ev({ type: "tool-start", callId: "c", name: "bash", args: { command: "pwd" } }),
	ev({ type: "tool-end", callId: "a", result: "A", isError: false }),
	ev({ type: "tool-end", callId: "b", result: "B", isError: false }),
	ev({ type: "tool-end", callId: "c", result: "C", isError: false }),
	ev({ type: "text-delta", text: "Next." }),
	ev({ type: "tool-start", callId: "d", name: "bash", args: { command: "date" } }),
	ev({ type: "tool-end", callId: "d", result: "D", isError: false }),
	ev({ type: "turn-end", reason: "complete" }),
];

const history: ThreadMessage[] = [
	{ id: "u", role: "user", text: "go", at: base.at },
	{
		id: "entry-2",
		role: "assistant",
		text: "Next.",
		at: base.at,
		tools: [
			{ callId: "a", name: "bash", args: { command: "ls" }, result: "A", isError: false, textOffset: 0 },
			{ callId: "b", name: "read", args: { path: "x" }, result: "B", isError: false, textOffset: 0 },
			{ callId: "c", name: "bash", args: { command: "pwd" }, result: "C", isError: false, textOffset: 0 },
			{ callId: "d", name: "bash", args: { command: "date" }, result: "D", isError: false, textOffset: 5 },
		],
	},
];

/** The keys thread-chat.tsx gives the rows of each assistant message (a group's key, then its rows'). */
function keysOf(model: SessionModel): string[][] {
	return model
		.getState()
		.messages.filter((m) => m.role === "assistant")
		.map((m) =>
			renderItems(m.parts, false).flatMap((i) =>
				i.kind === "tool"
					? [`tool:${i.key}`]
					: i.kind === "group"
						? [i.key, ...i.items.map((t) => `tool:${t.key}`)]
						: i.kind === "separator"
							? [`sep-${i.index}`]
							: [`${i.kind}:${i.part.id || i.index}`],
			),
		);
}

function assertUnique(model: SessionModel) {
	const groups = keysOf(model);
	assert.ok(groups.length > 0);
	for (const keys of groups) assert.equal(new Set(keys).size, keys.length, `duplicate keys: ${keys.join(", ")}`);
}

function replay(model: SessionModel) {
	const wire = threadTransport("w", "t").createWire();
	for (const e of events()) for (const w of wire(e as never)) model.applyWireEvent(w);
}

const make = (initialMessages: ReturnType<typeof threadMessagesToNative> = []) =>
	new SessionModel({ chatId: "t", initialMessages, transport: threadTransport("w", "t") });

describe("tool row keys are unique", () => {
	it("live", () => {
		const model = make();
		replay(model);
		assertUnique(model);
	});

	it("history", () => {
		assertUnique(make(threadMessagesToNative(history)));
	});

	it("a reused id (call_0) in two separate turns keeps both calls, each with its own result", () => {
		const turn = (id: string, result: string): ThreadMessage => ({
			id,
			role: "assistant",
			text: "",
			at: base.at,
			tools: [{ callId: "call_0", name: "bash", args: { command: "git status" }, result, isError: false, textOffset: 0 }],
		});
		const model = make(
			threadMessagesToNative([
				{ id: "u1", role: "user", text: "one", at: base.at },
				turn("entry-2", "first"),
				{ id: "u2", role: "user", text: "two", at: base.at },
				turn("entry-5", "second"),
			]),
		);
		assertUnique(model);
		const calls = model.getState().messages.flatMap((m) => m.parts).filter((p) => p.type.startsWith("tool-"));
		assert.deepEqual(calls.map((p) => p.output), ["first", "second"]);
	});

	it("a reused id repeated across rounds of ONE turn (same record) keeps every call, with unique keys", () => {
		const call = (r: string) => ({ callId: "call_0", name: "bash", args: { command: "git status" }, result: r, isError: false, textOffset: 0 });
		const model = make(threadMessagesToNative([{ id: "u", role: "user", text: "x", at: base.at }, { id: "entry-2", role: "assistant", text: "", at: base.at, tools: [call("r1"), call("r2")] }]));
		assertUnique(model);
		const calls = model.getState().messages.flatMap((m) => m.parts).filter((p) => p.type.startsWith("tool-"));
		assert.equal(calls.length, 2);
	});

	it("live replay over a record that already holds the same calls (settle refetch / reattach)", () => {
		const model = make(threadMessagesToNative(history));
		replay(model);
		assertUnique(model);
		const calls = model.getState().messages.flatMap((m) => m.parts).filter((p) => p.type.startsWith("tool-"));
		assert.deepEqual(calls.map((p) => p.toolCallId), ["a", "b", "c", "d"]);
	});

	it("a replay holding only folded calls adds no empty reasoning placeholder", () => {
		const model = make(threadMessagesToNative(history));
		replay(model);
		const parts = model.getState().messages.flatMap((m) => m.parts);
		assert.equal(parts.filter((p) => p.type === "reasoning").length, 0);
	});
});

describe("renderItems keys", () => {
	it("legacy records reusing an id with different arguments still get unique keys", () => {
		const part = (command: string) => ({ type: "tool-bash", toolCallId: "call_0", state: "output-available", input: { command }, output: "o" });
		const keys = renderItems([{ type: "step-start" }, part("a"), part("b"), part("c")], false).map((i) => (i.kind === "group" ? i.items.map((t) => t.key).join("|") : ""));
		assert.equal(new Set(keys[0]!.split("|")).size, 3);
	});
});
