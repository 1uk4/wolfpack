/**
 * THE THREAD ADAPTER: the seam between the ConsoleClient vocabulary
 * (@wolfpack/client — ThreadMessage / ThreadEvent) and the session model's
 * view protocol (pi's native messages + AgentEvent-shaped wire events that
 * SessionModel.applyWireEvent folds). PURE — no React, no IO.
 *
 * Permanent by design: the mock client speaks the same events the real SDK
 * will, so this module is the one place that knows both dialects.
 *
 * The mapping mirrors pi's loop shape — one assistant MESSAGE per model
 * step: deltas build a message (message_start on its first content,
 * message_update — the FULL partial, never a delta — after that); a tool
 * call's end closes the step (message_end + turn_end carrying the results
 * batch); the next delta opens the following step's message. The turn-end
 * event closes whatever is open.
 *
 * Resume tolerance: the adapter never requires turn-start. A consumer that
 * resumes mid-turn (events with id > N) gets a message opened by the first
 * delta it sees; a tool-end whose tool-start was missed still yields its
 * execution. Replaying a whole turn from its start (what the session model
 * does on reattach) reproduces the uninterrupted result exactly.
 */

import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { SnapshotEvent, ThreadEvent, ThreadMessage, ThreadObject, ThreadToolCall } from "@wolfpack/client";
import type { ChatListItem } from "./contracts/chat.ts";
import type { LhMessage } from "./native-messages.ts";
import type { ChildThread } from "./subagents.ts";

/** One AgentEvent-shaped wire event (what SessionModel.applyWireEvent eats). */
export type WireEvent = Record<string, unknown> & { type: string };

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type Block = AssistantMessage["content"][number];

function assistantShell(content: Block[], timestamp: number, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "console-client",
		provider: "console-client",
		model: "console-client",
		usage: ZERO_USAGE,
		stopReason,
		timestamp,
	} as unknown as AssistantMessage;
}

/** Strip the single blank-line seam ("\n\n") the server joins merged rounds with, at either edge. */
const trimSeam = (t: string): string => t.replace(/^\n\n/, "").replace(/\n\n$/, "");

/**
 * History (ThreadMessage[]) → the native record the session model seeds from.
 * An assistant message with `tools` expands to the live shape: one assistant
 * step per run of calls sharing a `textOffset` (text before it + the toolCalls),
 * each followed by its toolResults, then the remaining text as a final message.
 * A message without `tools` (old servers) stays a single text message.
 */
export function threadMessagesToNative(messages: readonly ThreadMessage[]): LhMessage[] {
	return messages.flatMap((m): LhMessage[] => {
		const timestamp = Date.parse(m.at) || 0;
		if (m.role === "user") {
			return [{ id: m.id, role: "user", content: m.text, timestamp } as UserMessage & { id: string }];
		}
		// Tool calls and objects share one offset-ordered list: an object follows the call that showed it.
		type Item = { tool: ThreadToolCall } | { object: ThreadObject };
		const items: Array<Item & { at: number }> = [
			...(m.tools ?? []).map((tool, n) => ({ tool, at: tool.textOffset ?? -1, n })),
			...(m.objects ?? []).map((object, n) => ({ object, at: object.textOffset ?? -1, n: n + 1e6 })),
		]
			.sort((a, b) => (a.at === b.at ? a.n - b.n : a.at - b.at))
			.map(({ n: _n, ...x }) => x as Item & { at: number });
		if (items.length === 0) {
			return [{ id: m.id, ...assistantShell([{ type: "text", text: m.text }], timestamp, "stop") } as LhMessage];
		}
		const out: LhMessage[] = [];
		let cursor = 0;
		let i = 0;
		let step = 0;
		while (i < items.length) {
			// A missing textOffset (-1) inherits the cursor, as for tools.
			const at = (n: number) => Math.min(Math.max(items[n]!.at < 0 ? cursor : items[n]!.at, cursor), m.text.length);
			const offset = at(i);
			const group: Item[] = [];
			while (i < items.length && at(i) === offset) group.push(items[i++]!);
			const text = trimSeam(m.text.slice(cursor, offset));
			cursor = offset;
			const calls = group.flatMap((g) => ("tool" in g ? [g.tool] : []));
			const content: Block[] = [
				...(text ? [{ type: "text", text } as Block] : []),
				...group.map((g) =>
					"tool" in g
						? ({ type: "toolCall", id: g.tool.callId, name: g.tool.name, arguments: g.tool.args ?? {} } as Block)
						: ({ type: "object", objectId: g.object.objectId, objectType: g.object.type, rev: g.object.rev, data: g.object.data, upsertSeq: g.object.seq } as unknown as Block),
				),
			];
			out.push({ id: step === 0 ? m.id : `${m.id}-s${step}`, ...assistantShell(content, timestamp, "toolUse") } as LhMessage);
			step++;
			for (const c of calls) {
				if (c.result === undefined) continue;
				const result = c.resultTruncated ? `${c.result}\n… (truncated)` : c.result;
				out.push({
					role: "toolResult",
					toolCallId: c.callId,
					toolName: c.name,
					content: [{ type: "text", text: result }],
					details: result,
					isError: c.isError === true,
					timestamp,
				} as unknown as LhMessage);
			}
		}
		const tail = trimSeam(m.text.slice(cursor));
		if (tail) out.push({ id: `${m.id}-s${step}`, ...assistantShell([{ type: "text", text: tail }], timestamp, "stop") } as LhMessage);
		return out;
	});
}

/** Stateful ThreadEvent → wire-event folder. One instance per consume. */
export class ThreadEventAdapter {
	private blocks: Block[] | null = null;
	private startedAt = 0;
	private openCalls = new Set<string>();
	private callNames = new Map<string, string>();
	private results: ToolResultMessage[] = [];
	private lastError: string | undefined;
	/** Text/thinking of this turn's already-closed messages (a snapshot's turn-wide partial is relative to it). */
	private closedText = "";
	private closedThinking = "";
	/** A turn-start was seen, so closedText/closedThinking cover the whole turn (false after a mid-turn reattach). */
	private sawTurnStart = false;

	apply(ev: ThreadEvent | SnapshotEvent): WireEvent[] {
		const at = Date.parse(ev.at) || 0;
		switch (ev.type) {
			case "snapshot":
				return this.applySnapshot(ev, at);
			case "turn-start":
				this.reset();
				return [{ type: "agent_start" }];
			case "thinking-delta":
				return this.grow(at, (blocks) => appendText(blocks, "thinking", ev.text));
			case "text-delta":
				return this.grow(at, (blocks) => appendText(blocks, "text", ev.text));
			case "tool-start":
				this.openCalls.add(ev.callId);
				this.callNames.set(ev.callId, ev.name);
				return this.grow(at, (blocks) => [
					...blocks,
					{ type: "toolCall", id: ev.callId, name: ev.name, arguments: ev.args } as Block,
				]);
			case "tool-update":
				return []; // the call stays input-streaming; output lands with tool-end
			case "tool-end":
				return this.endTool(ev, at);
			case "object-upsert":
				// Lands in the open message by arrival (the server emits it just before the call's tool-end, so it
				// shares the call's step); `textOffset` only matters on reload. projectView folds revisions
				// (max rev wins, first position — src/core/objects.ts).
				return this.grow(at, (blocks) => [
					...blocks,
					{ type: "object", objectId: ev.objectId, objectType: ev.objectType, rev: ev.rev, data: ev.data } as unknown as Block,
				]);
			case "card-pending":
			case "card-settled":
				return []; // cards are not part of the message stream: thread-chat folds them (foldCardEvent)
			case "turn-end":
				return this.endTurn(ev.reason, at);
			case "error":
				this.lastError = ev.message;
				return [{ type: "error", errorText: ev.message }];
		}
	}

	private reset(): void {
		this.blocks = null;
		this.openCalls.clear();
		this.results = [];
		this.lastError = undefined;
		this.closedText = "";
		this.closedThinking = "";
		this.sawTurnStart = true;
	}

	/**
	 * A server snapshot (a diverged retry corrected, or a stale-cursor baseline): the in-flight text it carries is
	 * authoritative, so the open message's text/thinking are REPLACED by it (minus what earlier closed messages of
	 * the turn already showed). Tool-call blocks are kept. History is not rewritten here: the settle refetch owns it.
	 */
	private applySnapshot(ev: SnapshotEvent, at: number): WireEvent[] {
		const f = ev.inFlight;
		if (!f) return [];
		// Without the turn's start, what earlier messages showed is unknown: replacing would duplicate them. The
		// settle refetch repairs the view instead.
		if (!this.sawTurnStart) return [];
		const fullThinking = f.thinking ?? "";
		if (!f.text.startsWith(this.closedText) || !fullThinking.startsWith(this.closedThinking)) {
			if (process.env.WOLFPACK_DEBUG_STREAM === "1") console.debug("[thread-adapter] snapshot does not extend the closed messages; ignored");
			return [];
		}
		const text = f.text.slice(this.closedText.length);
		const thinking = fullThinking.slice(this.closedThinking.length);
		if (this.blocks === null && !text && !thinking) return [];
		// Rebuild order mirrors the stream: thinking first, then text, then the tool calls already issued.
		return this.grow(at, (blocks) => [
			...(thinking ? [{ type: "thinking", thinking } as Block] : []),
			...(text ? [{ type: "text", text } as Block] : []),
			...blocks.filter((b) => b.type !== "text" && b.type !== "thinking"),
		]);
	}

	/** Open-or-grow the in-flight message; emit its FULL partial. */
	private grow(at: number, next: (blocks: Block[]) => Block[]): WireEvent[] {
		const opening = this.blocks === null;
		if (opening) this.startedAt = at;
		this.blocks = next(this.blocks ?? []);
		return [
			{
				type: opening ? "message_start" : "message_update",
				message: assistantShell(this.blocks, this.startedAt, "pending"),
			},
		];
	}

	private endTool(ev: Extract<ThreadEvent, { type: "tool-end" }>, at: number): WireEvent[] {
		const toolName = this.callNames.get(ev.callId) ?? "tool";
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: ev.callId,
			toolName,
			content: [{ type: "text", text: ev.result }],
			details: ev.result,
			isError: ev.isError,
			timestamp: at,
		} as ToolResultMessage;
		this.results.push(result);
		this.openCalls.delete(ev.callId);
		const out: WireEvent[] = [
			{
				type: "tool_execution_end",
				toolCallId: ev.callId,
				toolName,
				isError: ev.isError,
				result: { content: result.content, details: result.details },
			},
		];
		// The step closes once every call it issued has ended (pi's batch).
		if (this.openCalls.size === 0) {
			const message = this.close("toolUse", at);
			if (message) out.push({ type: "message_end", message });
			out.push({ type: "turn_end", message, toolResults: this.results });
			this.results = [];
		}
		return out;
	}

	private endTurn(reason: "complete" | "aborted" | "error", at: number): WireEvent[] {
		const stop = reason === "complete" ? "stop" : reason;
		const out: WireEvent[] = [];
		const message = this.close(stop, at);
		if (message) {
			out.push({ type: "message_end", message });
			out.push({ type: "turn_end", message, toolResults: this.results });
		}
		this.results = [];
		this.openCalls.clear();
		out.push({ type: "agent_end", messages: [] });
		return out;
	}

	private close(stopReason: AssistantMessage["stopReason"], at: number): AssistantMessage | null {
		if (this.blocks === null) return null;
		for (const b of this.blocks) {
			if (b.type === "text") this.closedText += (b as { text: string }).text;
			else if (b.type === "thinking") this.closedThinking += (b as { thinking: string }).thinking;
		}
		const message = assistantShell(this.blocks, this.startedAt || at, stopReason);
		if (stopReason === "error") message.errorMessage = this.lastError ?? "The turn failed.";
		this.blocks = null;
		return message;
	}
}

/** Append a delta to the trailing block of the same kind, else start a new one. */
function appendText(blocks: Block[], kind: "text" | "thinking", delta: string): Block[] {
	const last = blocks[blocks.length - 1];
	if (last && last.type === kind) {
		const merged =
			kind === "text"
				? ({ type: "text", text: (last as { text: string }).text + delta } as Block)
				: ({ type: "thinking", thinking: (last as { thinking: string }).thinking + delta } as Block);
		return [...blocks.slice(0, -1), merged];
	}
	return [...blocks, kind === "text" ? ({ type: "text", text: delta } as Block) : ({ type: "thinking", thinking: delta } as Block)];
}

/** Thread routing helpers: ids may carry the wolf prefix ("1uk4/home"), which
 *  doesn't belong in a URL segment. */
export function threadSlug(wolf: string, threadId: string): string {
	return threadId.startsWith(`${wolf}/`) ? threadId.slice(wolf.length + 1) : threadId;
}

export function threadHref(wolf: string, threadId: string): string {
	return `/wolf/${encodeURIComponent(wolf)}/thread/${encodeURIComponent(threadSlug(wolf, threadId))}`;
}

/** Slug → the client's thread id among `threads` (null when none matches). */
export function resolveThreadId(wolf: string, slug: string, threads: readonly { id: string }[]): string | null {
	return threads.find((t) => threadSlug(wolf, t.id) === slug)?.id ?? null;
}

/** A sidebar row for a thread: the existing ChatListItem shape (so SessionRow
 *  renders it unchanged) + the route it opens and its meta line. */
export function threadListItem(
	wolf: string,
	thread: { id: string; title: string; status?: "idle" | "busy" | "needs-you"; closed?: boolean } & Omit<ChildThread, "id" | "title">,
	busy = thread.status === "busy",
): ChatListItem & { href: string; meta: string; needsYou: boolean } & Omit<ChildThread, "id" | "title"> {
	const now = new Date().toISOString();
	return {
		id: thread.id,
		title: thread.title,
		createdAt: now,
		updatedAt: now,
		messageCount: 0,
		pendingQuestion: false,
		busy,
		compacting: false,
		href: threadHref(wolf, thread.id),
		meta: wolf,
		needsYou: thread.status === "needs-you",
		// A graduated feature's thread is read-only history: the sidebar files it under "Archived".
		...(thread.closed ? { archived: true } : {}),
		// A subagent's fields ride the row (the sidebar nests it under its parent, the job list reads its state).
		...(thread.parentThreadId !== undefined ? { parentThreadId: thread.parentThreadId } : {}),
		...(thread.agent !== undefined ? { agent: thread.agent } : {}),
		...(thread.state !== undefined ? { state: thread.state } : {}),
		...(thread.queuePosition !== undefined ? { queuePosition: thread.queuePosition } : {}),
		...(thread.startedAt !== undefined ? { startedAt: thread.startedAt } : {}),
		...(thread.finishedAt !== undefined ? { finishedAt: thread.finishedAt } : {}),
		...(thread.step !== undefined ? { step: thread.step } : {}),
		...(thread.tokens !== undefined ? { tokens: thread.tokens } : {}),
		...(thread.taskId !== undefined ? { taskId: thread.taskId } : {}),
	};
}
