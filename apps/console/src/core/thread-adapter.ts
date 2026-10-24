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
import type { ThreadEvent, ThreadMessage } from "@wolfpack/client";
import type { ChatListItem } from "./contracts/chat.ts";
import type { LhMessage } from "./native-messages.ts";

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

/** History (ThreadMessage[]) → the native record the session model seeds from. */
export function threadMessagesToNative(messages: readonly ThreadMessage[]): LhMessage[] {
	return messages.map((m): LhMessage => {
		const timestamp = Date.parse(m.at) || 0;
		if (m.role === "user") {
			return { id: m.id, role: "user", content: m.text, timestamp } as UserMessage & { id: string };
		}
		return {
			id: m.id,
			...assistantShell([{ type: "text", text: m.text }], timestamp, "stop"),
		} as LhMessage;
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

	apply(ev: ThreadEvent): WireEvent[] {
		const at = Date.parse(ev.at) || 0;
		switch (ev.type) {
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
	thread: { id: string; title: string },
	busy = false,
): ChatListItem & { href: string; meta: string } {
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
	};
}
