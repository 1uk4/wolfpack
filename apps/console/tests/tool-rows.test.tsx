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
import { ToolGroup, ToolRow, truncateResult } from "../components/tool-row.tsx";
import { ASSISTANT_CONTENT_CLASS, PROSE_BLOCK_CLASS, renderItems, runOpen, stripCd, summarizeArgs, summarizeGroup, threadMessagesToNative, toolEntryOf } from "../src/core/index.ts";

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
				i.kind === "tool" ? { kind: i.kind, ...i.entry } : i.kind === "group" ? { kind: i.kind, entries: i.entries } : i.kind === "text" ? { kind: i.kind, text: i.part.text } : { kind: i.kind },
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
			["tool", "text", "group", "text"],
		);
		const tools = turn!.flatMap((i) => (i.kind === "group" ? (i as { entries: unknown[] }).entries : i.kind === "tool" ? [i] : [])) as Array<{
			name: string;
			summary: string;
			status: string;
			result: string;
		}>;
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

const call = (id: string, name: string, state: string, input: unknown = { command: id }) => ({
	type: `tool-${name}`,
	toolCallId: id,
	state,
	input,
	output: "o",
	errorText: "e",
});

describe("tool groups", () => {
	it("a run of consecutive calls becomes one group; a single call stays a row", () => {
		const items = renderItems([{ type: "step-start" }, call("a", "bash", "output-available"), call("b", "read", "output-available", { path: "x" }), { type: "text", text: "hi" }, call("c", "bash", "output-available")], false);
		assert.deepEqual(items.map((i) => i.kind), ["group", "text", "tool"]);
	});

	it("empty thinking does not split a group; real thinking and text do", () => {
		const run = (mid: Array<Record<string, unknown>>) =>
			renderItems([{ type: "step-start" }, call("a", "bash", "output-available"), ...mid, call("b", "bash", "output-available")] as never, false).map((i) => i.kind);
		assert.deepEqual(run([{ type: "step-start" }, { type: "reasoning", text: "" }]), ["group"]);
		assert.deepEqual(run([{ type: "step-start" }, { type: "reasoning", text: "thinking" }]), ["tool", "reasoning", "tool"]);
		assert.deepEqual(run([{ type: "step-start" }, { type: "text", text: "t" }]), ["tool", "text", "tool"]);
	});

	it("summary: counts in first-seen order, latest/running call, overall status", () => {
		const e = (name: string, status: "running" | "done" | "error" | "pending", summary: string) => ({ callId: summary, name, summary, status });
		const s = summarizeGroup([e("bash", "done", "1"), e("read", "done", "2"), e("bash", "running", "3"), e("bash", "done", "4")]);
		assert.deepEqual(s.counts, [{ name: "bash", count: 3 }, { name: "read", count: 1 }]);
		assert.equal(s.status, "running");
		assert.equal(s.latest.summary, "3");
		assert.equal(summarizeGroup([e("bash", "done", "1"), e("bash", "error", "2"), e("bash", "done", "3")]).status, "error");
		assert.equal(summarizeGroup([e("bash", "done", "1"), e("bash", "done", "2")]).latest.summary, "2");
	});

	it("summary status precedence: running beats error beats done; all-pending stays pending", () => {
		const e = (status: "running" | "done" | "error" | "pending") => ({ callId: status, name: "bash", summary: status, status });
		assert.equal(summarizeGroup([e("done"), e("running")]).status, "running");
		assert.equal(summarizeGroup([e("error"), e("running"), e("done")]).status, "running");
		assert.equal(summarizeGroup([e("done"), e("error")]).status, "error");
		assert.equal(summarizeGroup([e("error"), e("done")]).status, "error");
		assert.equal(summarizeGroup([e("pending"), e("pending")]).status, "pending");
		assert.equal(summarizeGroup([e("pending"), e("done")]).status, "done");
	});

	it("expand state survives a lone row growing into a group", () => {
		const open = { c1: true };
		assert.equal(runOpen(open, "c1"), true); // the lone row
		assert.equal(runOpen(open, "group:c1", "c1"), true); // the group inherits
		assert.equal(runOpen(open, "c1"), true); // and the row inside it stays expanded
		assert.equal(runOpen({ ...open, "group:c1": false }, "group:c1", "c1"), false); // an explicit collapse wins
		assert.equal(runOpen({}, "group:c1", "c1"), false);
		const entry = { callId: "c1", name: "bash", summary: "x", status: "done" as const };
		assert.match(renderToStaticMarkup(<ToolRow entry={entry} open />), /<details[^>]* open/);
		assert.doesNotMatch(renderToStaticMarkup(<ToolRow entry={entry} open={false} />), /<details[^>]* open/);
	});

	it("ToolGroup renders counts, latest summary, status, and the rows", () => {
		const entries = [
			{ callId: "a", name: "bash", summary: "one", status: "done" as const },
			{ callId: "b", name: "bash", summary: "two", status: "done" as const },
			{ callId: "c", name: "read", summary: "/x", status: "error" as const },
		];
		const html = renderToStaticMarkup(
			<ToolGroup entries={entries}>
				{entries.map((en) => (
					<ToolRow key={en.callId} entry={en} />
				))}
			</ToolGroup>,
		);
		assert.match(html, /data-testid="tool-group"/);
		assert.match(html, /bash ×2 · read/);
		assert.match(html, /\/x/);
		assert.match(html, /data-status="error"/);
		assert.equal((html.match(/data-testid="tool-row"/g) ?? []).length, 3);
		assert.doesNotMatch(html, /<details[^>]*data-testid="tool-group"[^>]* open/);
	});

	it("live and reload group identically", () => {
		const live = new SessionModel({ chatId: "t", initialMessages: [], transport: threadTransport("w", "t") });
		const wire = threadTransport("w", "t").createWire();
		for (const e of liveEvents()) for (const w of wire(e as never)) live.applyWireEvent(w);
		const hist = new SessionModel({ chatId: "t", initialMessages: threadMessagesToNative(history), transport: threadTransport("w", "t") });
		const keys = (m: SessionModel) =>
			m.getState().messages.filter((x) => x.role === "assistant").flatMap((x) => renderItems(x.parts, false).map((i) => (i.kind === "group" ? i.key : i.kind)));
		assert.deepEqual(keys(hist), keys(live));
		const shape = (m: SessionModel) =>
			m.getState().messages.filter((x) => x.role === "assistant").flatMap((x) =>
				renderItems(x.parts, false).map((i) =>
					i.kind === "group" ? { kind: i.kind, key: i.key, rows: i.items.map((t) => [t.key, t.entry.name, t.entry.status]) } : i.kind === "tool" ? { kind: i.kind, key: i.key, name: i.entry.name } : { kind: i.kind },
				),
			);
		assert.deepEqual(shape(hist), shape(live));
		assert.ok(keys(live).includes("group:c2"));
	});
});

describe("bash summary", () => {
	it("strips a leading cd <path> && / ;", () => {
		assert.equal(stripCd("cd /Users/x/wt/1uk4-dev && npm test"), "npm test");
		assert.equal(stripCd("cd /a/b; ls -la"), "ls -la");
		assert.equal(stripCd('cd "/a b/c" && git status'), "git status");
		assert.equal(stripCd("cd /a && cd /b && make"), "make");
		assert.equal(stripCd("ls && cd /a"), "ls && cd /a");
		assert.equal(stripCd("cd /only"), "cd /only");
		assert.equal(stripCd("cd /a;cd /b; ls"), "ls"); // nested, `;` without a space
		assert.equal(stripCd("cd '/a b' && cd \"/c d\" && ls"), "ls"); // quoted paths
		assert.equal(stripCd('cd "/a \\"b\\"" && ls'), "ls"); // escaped quote inside a quoted path
		assert.equal(stripCd("cd /a\\ b && ls"), "ls"); // escaped space
		assert.equal(summarizeArgs("bash", { command: "cd /Users/lukaflores/Code/wolfpack-wt/1uk4-dev && npm test" }), "npm test");
	});

	it("keeps the full command for the expanded view", () => {
		const entry = toolEntryOf({ type: "tool-bash", toolCallId: "c", state: "output-available", input: { command: "cd /w && npm test" }, output: "ok" });
		assert.equal(entry.summary, "npm test");
		assert.equal(entry.command, "cd /w && npm test");
		const html = renderToStaticMarkup(<ToolRow entry={entry} />);
		assert.match(html, /data-testid="tool-row-command"[^>]*>cd \/w &amp;&amp; npm test</);
		for (const status of ["running", "pending"] as const) {
			const pending = renderToStaticMarkup(<ToolRow entry={{ ...entry, status, result: undefined }} />);
			assert.match(pending, /data-testid="tool-row-command"[^>]*>cd \/w &amp;&amp; npm test</);
		}
	});
});

describe("prose wrapping", () => {
	it("prose blocks and the assistant column can shrink and wrap; tool rows never leak nowrap into the layout", () => {
		for (const cls of [PROSE_BLOCK_CLASS, ASSISTANT_CONTENT_CLASS]) assert.match(cls, /\bmin-w-0\b/);
		assert.match(PROSE_BLOCK_CLASS, /break-words/);
		// anywhere would squash table min-content; pre/table/code keep normal wrapping
		assert.doesNotMatch(PROSE_BLOCK_CLASS, /anywhere/);
		for (const el of ["pre", "table", "code"]) assert.match(PROSE_BLOCK_CLASS, new RegExp(`\\[&_${el}\\]:\\[overflow-wrap:normal\\]`));
		assert.doesNotMatch(`${PROSE_BLOCK_CLASS} ${ASSISTANT_CONTENT_CLASS}`, /nowrap|truncate/);
		const row = renderToStaticMarkup(<ToolRow entry={{ callId: "c", name: "bash", summary: "x", status: "done" }} />);
		const root = row.match(/<details[^>]*>/)![0];
		assert.match(root, /min-w-0/);
		assert.doesNotMatch(root, /nowrap|truncate/);
	});
});

describe("thread-chat wiring", () => {
	it("applies the prose layout contract to the assistant column and text blocks", async () => {
		const { readFileSync } = await import("node:fs");
		const src = readFileSync(new URL("../components/thread-chat.tsx", import.meta.url), "utf8");
		assert.match(src, /<MessageContent className=\{ASSISTANT_CONTENT_CLASS\}>/);
		assert.match(src, /className=\{PROSE_BLOCK_CLASS\}/);
	});
});
