/**
 * The chat-turn services — one named, error-contained seam per turn
 * responsibility, extracted from the chat-handler so it composes instead of
 * implementing. Each takes its dependencies explicitly (storage ports, the
 * job runner) — no module here imports an adapter.
 *
 *   persistTurn        — the canonical state write (Wave B: native history;
 *                        id stamping, placeholder filtering, abort-partial
 *                        persistence)
 *
 * Logs are the minimal-observability baseline: one line per failure, tagged
 * [chat <id>] — structured logging lands behind these seams later.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { LhMessage } from "../core/native-messages.ts";
import { newMessageId } from "../core/native-messages.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import type { ChatStore } from "../core/ports.ts";

/**
 * The canonical state write (Wave B, owner-approved 2026-09-26): append the
 * turn's own messages — the agent loop's native history, provider/model/
 * usage/thinkingSignature stamped by pi itself. Persists even when aborted
 * — the partial transcript (including a pending question's unanswered
 * call) is what makes resume work.
 *
 * - Id stamping: pi messages carry no id; the record's identity needs one
 *   per message (client keys, append-only adoption, the continuation
 *   seam). Minted here, at the single canonical write.
 * - Placeholder filtering: a cleanly-posed question's synthetic
 *   "question posed" result is an in-memory loop device (Wave A's
 *   terminate) — NEVER persisted (fork 1: the record ends at the
 *   unanswered call; the learner's answer arrives as the real tool
 *   result). Errored question calls DO persist — the model's retry
 *   context.
 *
 * Returns the stamped new messages (usage provenance reads them).
 */
export function persistTurn(
	chatStore: ChatStore,
	chatId: string,
	baseCount: number,
	turnMessages: readonly AgentMessage[],
	isAborted: boolean,
): LhMessage[] {
	try {
		const record = chatStore.getChat(chatId);
		if (!record) return [];
		const stamped: LhMessage[] = [];
		for (const m of turnMessages.slice(baseCount)) {
			const message = m as LhMessage;
			// The placeholder question result: loop device, never a record fact.
			if (
				(message as { role?: string }).role === "toolResult" &&
				(QUESTION_TOOLS as readonly string[]).includes((message as ToolResultMessage).toolName) &&
				!(message as ToolResultMessage).isError
			) {
				continue;
			}
			stamped.push(message.id ? message : ({ ...message, id: newMessageId() } as LhMessage));
		}
		chatStore.saveMessages(chatId, [...record.messages, ...stamped]);
		return stamped;
	} catch (err) {
		console.error(`[chat ${chatId}] persist failed:`, err, { isAborted });
		return [];
	}
}
