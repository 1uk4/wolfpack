/**
 * Chat-session contracts — records, summaries, UI extension points
 *
 * Part of the domain-split contracts (src/core/contracts/): each domain file
 * is owned outright by its stream — cross-domain schema changes go through
 * master. Pure types + protocol docs + tiny pure helpers. See docs/vision.md.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { LhMessage } from "../native-messages.ts";

// ─── Chat records (the session store's on-disk format) ───────────────────────

/** One persisted session: data/chats/<id>.json. Wave B (owner-approved
 * 2026-09-26): the stored messages are pi-NATIVE history (LhMessage — the
 * agent loop's own shapes, provider/model/usage/thinkingSignature stamped
 * by pi) — the canonical session record IS the agent state; replay is
 * `state.messages = record.messages` + continue(). The client-shaped view
 * is the client's own grouping fold (core/view.ts, Wave D) — a pending quiz
 * is an unanswered question tool call, which is exactly what makes
 * resume-mid-question free. */
export interface ChatRecord {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messages: LhMessage[];
	/** Append-only usage log (observability, 2026-09): one entry per model
	 * turn. DELIBERATELY a parallel log, not per-message metadata — the client
	 * re-POSTs its message list every turn and its copies never carry
	 * server-stamped fields, so anything inside message objects gets clobbered
	 * by the next persist. Keyed by messageId so the transcript view can fold
	 * each entry onto its message; aggregates are folds over this log
	 * (core/prices.ts). */
	turns?: TurnUsage[];
	/** Per-chat model/thinking overrides for the conversation agents. */
	settings?: ChatSettings;
	/** SCHEMA STAMP (schema-versioning wave, owner 2026-10-10): LAZY v1 —
	 *  existing records stay unstamped (absence reads as v1); every write
	 *  stamps the current version. A record stamped NEWER than this build
	 *  (the downgrade scenario) is REFUSED on read: a read-modify-write
	 *  store must never rewrite what it doesn't understand. */
	version?: number;
}

/** The chat record format this build writes and understands. */
export const CURRENT_CHAT_VERSION = 1;

/** The conversation agents' runtime model choice (model-control wave,
 *  2026-09-12): a per-chat override of config.ts's pinned prober/teacher
 *  spec. Absent fields fall back to config; written by the model picker
 *  (PUT /api/chats/[id]/settings) and read at turn composition — the
 *  agents are stateless per turn, so a change takes effect on the next
 *  turn by construction. Background sub-agents are NEVER overridden
 *  (config-pinned: they're infrastructure, not conversation). */
export interface ChatSettings {
	/** pi-ai catalog coordinates: the provider that owns the model. Only
	 *  "openrouter" is configured today; the field exists so a second
	 *  provider needs no schema change. */
	model?: { provider: string; id: string };
	/** pi thinking level — must be in the chosen model's supported list
	 *  (getSupportedThinkingLevels; enforced by the settings route). */
	thinkingLevel?: ThinkingLevel;
}


// ─── Usage accounting (the money channel) ─────────────────────────────────────

/** One model call's token accounting — the SDK's LanguageModelUsage
 * flattened to the fields we persist (undefined = provider didn't report;
 * renderers show absent, never zero). */
export interface CallUsage {
	/** Total input (prompt) tokens, cached portion included. */
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	/** Cached input tokens READ (billed at the cache-read rate, if any). */
	cacheReadTokens: number | undefined;
	/** Input tokens written to the cache this call (OpenRouter bills writes
	 * for some providers; undefined = not reported/not billed). */
	cacheWriteTokens: number | undefined;
	/** The reasoning portion of the output tokens. */
	reasoningTokens: number | undefined;
}

/** One billing turn: one full invocation of the teacher (a client turn or a
 * wake turn — same handler, same log). A turn with tool calls spans several
 * agent steps, and each step bills separately. Capture lands at the persist
 * seam (server); cost is INFERRED at read time from core/prices.ts. */
export interface TurnUsage {
	/** Unique per REQUEST (turn): one invocation of the handler — the
	 *  idempotency key for the append-only log. Continuation turns share a
	 *  response message id (the SDK coalesces them); keying on messageId
	 *  would swallow their usage. */
	id: string;
	/** The assistant message the turn produced — provenance, keys this
	 *  entry to the transcript (the block this turn "belongs" to). */
	messageId: string;
	at: string;
	/** The model that ran the turn, provider-qualified ("provider:id" —
	 *  model slots wave, 2026-09-20; matches PRICES' uniform keys). */
	model: string;
	/** One entry per agent step (model call) in this turn. */
	steps: CallUsage[];
}

/** The compaction marker's model-facing header (owner round 14,
 *  2026-10-05). The marker's content is this header + the summary — the
 *  single text the provider sees in place of the dropped span. Wording
 *  law: it must tell the model (a) a cut happened and is routine, (b) the
 *  summary replaces everything before it, (c) what follows is verbatim
 *  recent transcript — so the model neither re-asks covered ground nor
 *  distrusts the seam. */
export const COMPACTED_HISTORY_HEADER =
	"[SESSION HISTORY COMPACTED] The transcript before this point was summarized to fit the context window; the summary below replaces it. Everything after this message is the verbatim recent transcript.";


/** The list view's shape (messageCount instead of full messages) + the
 *  per-session status the picker renders. `pendingQuestion` derives from
 *  the stored record; the store computes it in listChats. Liveness
 *  (`busy`) is NOT record-derived — the API route merges it in (see
 *  ChatListItem). */
export interface ChatSummary {
	id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	messageCount: number;
	/** An unanswered quiz/ask question is waiting for the learner. */
	pendingQuestion: boolean;
	/** The record's model-control settings — rides the list payload via the
	 *  summary spread (the picker never needs it from here; the full record
	 *  is its source). */
	settings?: ChatSettings;
}

/** The sidebar's session row: a summary + live liveness. The chats list
 *  route attaches `busy` from the turn-liveness registry ONLY — a running
 *  teach turn (owner, minimal-color round: background jobs no longer
 *  count; the sidebar's Background agents section is their channel, and
 *  the row spinner means exactly "a turn is in flight"). The store itself
 *  can't see liveness (import law: store never imports server), hence the
 *  split at exactly the record/liveness seam. */
export interface ChatListItem extends ChatSummary {
	busy: boolean;
	/** Live compaction liveness (turn-liveness's twin): true while a
	 *  background context compaction holds the chat's model gate. The
	 *  route attaches it from the compaction registry — never
	 *  record-derived (the marker persists, the RUN is ephemeral). */
	compacting: boolean;
}

// ─── Card registry (client extension point) ─────────────────────────────────

/**
 * components/chat.tsx renders tool parts via components/card-registry.tsx,
 * keyed by tool name ("research", "demo", "visual", …). Workers add
 * renderers there — chat.tsx is off-limits to artifact work. Renderer receives the raw tool part; it typically renders
 * an activity card while state is input-available (poll /api/jobs) and the
 * artifact (iframe / svg) when output-available.
 */
export interface ArtifactPartProps {
	part: {
		type: string;
		state: string;
		toolCallId: string;
		input?: unknown;
		output?: unknown;
	};
}
