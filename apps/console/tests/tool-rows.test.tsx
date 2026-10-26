/**
 * Tool rows: a live turn and the same turn reloaded from history render the
 * SAME entries; empty thinking renders nothing; no blank rows.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ThreadEvent, ThreadMessage } from "@wolfpack/client";
import { SessionModel } from "../components/session-core.ts";
import { threadTransport } from "../components/thread-transport.ts";
import { ToolRow, truncateResult } from "../components/tool-row.tsx";
import { renderItems, summarizeArgs, threadMessagesToNative, toolEntryOf } from "../src/core/index.ts";

const base = { threadId: "t", at: "2026-01-01T00:00:00.000Z", turnId: "a" };
let n = 0;
const ev = (e: Record<string, unknown>) => ({ ...base, id: ++n, ...e }) as unknown as ThreadEvent;

const LONG = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");

/** Opus-style rounds: signature-only (empty) thinking + a tool call each, then the final text. */
function liveEvents(): ThreadEvent[] {
	return [
		ev({ type: "turn-start" }),
		ev({ type: "thinking-delta", text: "" }),
		ev({ type: "tool-start", callId: "c1", name: "bash", args: { command: "ls -la" } }),
		ev({ type: "tool-end", callId: "c1", result: LONG, isError: false }),
		ev({ type: "thinking-delta", text: "" }),
		ev({ type: "text-delta", text: "Binding it." }),
		ev({ type: "tool-start", callId: "c2", name: "task_bind", args: { id: "work-1" } }),
		ev({ type: "tool-end", callId: "c2", result: "bound", isError: false }),
		ev({ type: "tool-start", callId: "c3", name: "read", args: { path: "/nope" } }),
		ev({ type: "tool-end", callId: "c3", result: "ENOENT", isError: true }),
		ev({ type: "text-delta", text: "Done." }),
		ev({ type: "turn-end", reason: "complete" }),
	];
}

/** The same turn as getThread would return it. */
const history: ThreadMessage[] = [
	{ id: "u", role: "user", text: "bind it", at: base.at },
	{
		id: "entry-2",
		role: "assistant",
		text: "Binding it.\n\nDone.",
		at: base.at,
		tools: [
			{ callId: "c1", name: "bash", args: { command: "ls -la" }, result: LONG, isError: false, textOffset: 0 },
			{ callId: "c2", name: "task_bind", args: { id: "work-1" }, result: "bound", isError: false, textOffset: 11 },
			{ callId: "c3", name: "read", args: { path: "/nope" }, result: "ENOENT", isError: true, textOffset: 11 },
		],
	},
];

function describeView(model: SessionModel) {
	return model
		.getState()
		.messages.filter((m) => m.role === "assistant")
		.map((m) =>
			renderItems(m.parts, false).map((i) =>
				i.kind === "tool" ? { kind: i.kind, ...i.entry } : i.kind === "text" ? { kind: i.kind, text: i.part.text } : { kind: i.kind },
			),
		);
}

function liveModel(): SessionModel {
	const model = new SessionModel({ chatId: "t", initialMessages: [], transport: threadTransport("w", "t") });
	const wire = threadTransport("w", "t").createWire();
	for (const e of liveEvents()) for (const w of wire(e as never)) model.applyWireEvent(w);
	return model;
}

describe("tool rows", () => {
	it("live: named tool entries paired with results, no thinking, no separators", () => {
		const [turn] = describeView(liveModel());
		assert.deepEqual(
			turn!.map((i) => i.kind),
			["tool", "text", "tool", "tool", "text"],
		);
		const tools = turn!.filter((i) => i.kind === "tool") as Array<{ name: string; summary: string; status: string; result: string }>;
		assert.deepEqual(
			tools.map((t) => [t.name, t.summary, t.status, t.result === LONG ? "LONG" : t.result]),
			[
				["bash", "ls -la", "done", "LONG"],
				["task_bind", "work-1", "done", "bound"],
				["read", "/nope", "error", "ENOENT"],
			],
		);
	});

	it("history renders the same entries as the live turn", () => {
		const model = new SessionModel({ chatId: "t", initialMessages: threadMessagesToNative(history), transport: threadTransport("w", "t") });
		assert.deepEqual(describeView(model), describeView(liveModel()));
	});

	it("history without tools (old server) is a single text message", () => {
		const native = threadMessagesToNative([{ id: "a", role: "assistant", text: "hi", at: base.at }]);
		assert.equal(native.length, 1);
	});

	it("empty or whitespace thinking renders nothing; real thinking stays", () => {
		const parts = [
			{ type: "step-start" },
			{ type: "reasoning", text: "" },
			{ type: "reasoning", text: "  \n" },
			{ type: "tool-bash", toolCallId: "c", state: "input-available", input: { command: "x" } },
			{ type: "step-start" },
			{ type: "reasoning", text: "hmm" },
			{ type: "text", text: "ok" },
		];
		assert.deepEqual(
			renderItems(parts, false).map((i) => i.kind),
			["tool", "reasoning", "text"],
		);
		// the streaming placeholder (empty LAST part) keeps its row
		assert.deepEqual(renderItems([{ type: "step-start" }, { type: "reasoning", text: "" }], true).map((i) => i.kind), ["reasoning"]);
		assert.deepEqual(renderItems([{ type: "step-start" }, { type: "reasoning", text: "" }], false), []);
	});

	it("summaries", () => {
		assert.equal(summarizeArgs("bash", { command: "a\n  b" }), "a b");
		assert.equal(summarizeArgs("bash", { command: "x".repeat(300) }).length, 100);
		assert.equal(summarizeArgs("edit", { path: "a.ts", oldText: "x" }), "a.ts");
		assert.equal(summarizeArgs("task_update", { id: "work-9", body: "zzz" }), "work-9");
		assert.equal(summarizeArgs("task_create", { title: "T", kind: "task" }), "T");
		assert.equal(summarizeArgs("weird", { n: 1, q: "first" }), "first");
		assert.equal(summarizeArgs("weird", undefined), "");
	});

	it("statuses", () => {
		const p = { type: "tool-bash", toolCallId: "c", input: {} };
		assert.equal(toolEntryOf({ ...p, state: "input-streaming" }).status, "running");
		assert.equal(toolEntryOf({ ...p, state: "output-available", output: "o" }).status, "done");
		assert.equal(toolEntryOf({ ...p, state: "output-error", errorText: "e" }).status, "error");
	});

	it("ToolRow: collapsed one-liner with name, summary, status; result expandable, truncated", () => {
		const entry = { callId: "c1", name: "bash", summary: "ls -la", status: "done" as const, result: LONG };
		const html = renderToStaticMarkup(<ToolRow entry={entry} />);
		assert.match(html, /data-testid="tool-row"/);
		assert.doesNotMatch(html, /<details[^>]* open/);
		assert.match(html, /bash/);
		assert.match(html, /ls -la/);
		assert.match(html, />done</);
		assert.match(html, /show more/);
		assert.doesNotMatch(html, /line 39/);
		assert.ok(truncateResult(LONG).truncated);
		assert.ok(!truncateResult("short").truncated);
	});

	it("ToolRow: error is marked; running shows the spinner", () => {
		const err = renderToStaticMarkup(<ToolRow entry={{ callId: "c", name: "read", summary: "/x", status: "error", result: "ENOENT" }} />);
		assert.match(err, /text-red-500/);
		assert.match(err, />error</);
		assert.match(err, /ENOENT/);
		const run = renderToStaticMarkup(<ToolRow entry={{ callId: "c", name: "bash", summary: "sleep", status: "running" }} />);
		assert.match(run, /data-testid="braille-spinner"/);
		assert.match(run, />running</);
	});
});

describe("ToolRow with an artifact renderer", () => {
	it("registered tools (read) expand into the artifact card; others show text output", async () => {
		const { artifactRenderers } = await import("../components/artifacts/index.ts");
		const part = { type: "tool-read", toolCallId: "c", state: "output-available", input: { path: "a.md" }, output: "BODY" };
		const entry = { callId: "c", name: "read", summary: "a.md", status: "done" as const, result: "BODY" };
		const withCard = renderToStaticMarkup(<ToolRow entry={entry} artifact={{ Renderer: artifactRenderers.read!, part: part as never }} />);
		assert.match(withCard, /data-testid="tool-row"/);
		assert.match(withCard, /data-testid="tool-call-card"/);
		assert.doesNotMatch(withCard, /data-testid="tool-row-output"/);
		const plain = renderToStaticMarkup(<ToolRow entry={{ ...entry, name: "bash" }} />);
		assert.doesNotMatch(plain, /tool-call-card/);
		assert.match(plain, /data-testid="tool-row-output"/);
		assert.match(plain, /select-text/);
	});
});

describe("history seam handling", () => {
	it("trims only the single seam newline pair", () => {
		const native = threadMessagesToNative([
			{ id: "a", role: "assistant", text: "x\n\n\ny", at: base.at, tools: [{ callId: "c", name: "r", args: {}, textOffset: 4 }] },
		]);
		const first = native[0] as { content: Array<{ type: string; text?: string }> };
		assert.equal(first.content[0]!.text, "x\n");
	});
});
