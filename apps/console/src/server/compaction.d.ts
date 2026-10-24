/**
 * THE COMPACTION SERVICE (owner round 14, 2026-10-05): the trigger
 * plumbing around core/compaction's pure cuts and markers.
 *
 * TOPOLOGY (why this is simple): question and problem poses TERMINATE
 * their runs, so the "user is thinking" pause is always a BETWEEN-RUNS
 * window. Compaction therefore never touches a live run:
 *
 *   - SETTLE KICK — a turn settles (onFinish, after persist) and the
 *     projected context is over threshold: the summary starts NOW, in
 *     the background, while the learner reads/answers — usually done
 *     long before the next input arrives.
 *   - TURN-START GATE — every turn (client POST or wake) awaits any
 *     in-flight compaction for its chat BEFORE appends or beginTurn;
 *     if the record is STILL over threshold (cold sessions, kicks that
 *     lost their engine), compaction runs synchronously inside the
 *     request. Structurally gated: nothing model-facing for the chat
 *     interleaves with a running compaction (owner ruling — minimal
 *     surface for anything to go wrong).
 *   - OVERFLOW RECOVERY — a run that dies on context length needs no
 *     special path: the next turn's gate compacts and the fresh run
 *     starts small.
 *
 * The summary is written by the session's OWN conversation model (owner
 * ruling) via the zero-tool one-shot sub-agent seam; its usage lands in
 * the chat's append-only turns log (the money channel) keyed by the
 * marker's id.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { type LhMessage } from "../core/index.ts";
import type { ChatStore } from "../core/ports.ts";
import type { PiEngine } from "../agent/models.ts";
/** The one-shot summary call: zero tools, one turn, text out. The engine
 *  is the chat's own conversation engine (owner ruling: the session's
 *  model writes its own summary). Injectable for tests. */
export type Summarizer = (prompt: string, engine: PiEngine) => Promise<{
    summary: string;
    usage: Usage;
}>;
/** Everything the service needs from its host (chat-handler wires the
 *  production versions; tests inject). */
export interface CompactionDeps {
    chatStore: ChatStore;
    /** The chat's conversation engine — also the summarizer's. */
    engine: PiEngine;
    /** provider:id of the engine (usage + marker provenance). */
    modelId: string;
    /** The session kind (summarizer wording: tutor vs practice). */
    kind: "teach" | "practice" | "probe";
    /** The effective trigger threshold, RESOLVED by the caller:
     *  min(settings threshold, contextWindow − reserve) — the owner's
     *  effective-trigger ruling. The catalog window lookup is the
     *  caller's (chat-handler has the model id at hand). */
    thresholdTokens: number;
    /** The composed system prompt's token estimate (chars/4) — the
     *  projection the provider actually receives starts with it. */
    systemPromptTokens: number;
    /** Injectable summarizer (tests); default = the sub-agent one-shot. */
    summarize?: Summarizer;
}
/** Is a compaction running for this chat? (The client status event's
 *  server-side twin — tests and the SSE emitter read it.) */
export declare function compactionInFlight(chatId: string): boolean;
/** Await any in-flight compaction for the chat — the structural gate
 *  every model interaction for the chat passes through. */
export declare function awaitCompaction(chatId: string): Promise<void>;
/** Resolve the effective trigger. Unknown window → the setting alone
 *  (honest: no fake window — the catalog-index precedent). */
export declare function effectiveThresholdTokens(settingTokens: number | undefined, contextWindowTokens: number | undefined): number;
/** The projected context estimate: what the next LLM call would carry.
 *  THE TRIGGER LAW (pi's, verified 2026-10-05): anchor on the last
 *  assistant message's provider-reported usage — it already counted
 *  the system prompt, tool declarations, and the provider's own
 *  tokenizer — and chars/4-estimate ONLY messages appended after it.
 *  estimateContextTokens refuses anchors that predate a compaction
 *  marker (that usage described context the next request will NOT
 *  carry), so the fallback path runs the plain heuristic over the
 *  CUT-HONORED projection (never the dropped span) plus the additive
 *  prompt term the anchor would have covered. */
export declare function projectedContextTokens(messages: readonly LhMessage[], systemPromptTokens: number): number;
/**
 * The gate + trigger in one: await any in-flight compaction, then — if
 * the record is STILL over threshold — run one synchronously (the
 * caller's request waits; the owner's structural-gate ruling). Idempotent
 * under concurrency through the registry mutex.
 */
export declare function ensureCompacted(deps: CompactionDeps, chatId: string): Promise<void>;
/**
 * The settle kick (fire-and-forget): the turn settled, the learner is
 * about to read/answer — if the projection is over threshold, the
 * summary starts NOW and finishes inside the pause. Wired at
 * chat-handler's onFinish tail; engineless or over-threshold-nothing
 * are silent no-ops. The next turn's ensureCompacted gate picks up
 * whatever this leaves running.
 */
export declare function kickCompaction(buildDeps: () => CompactionDeps | null, chatId: string): void;
//# sourceMappingURL=compaction.d.ts.map