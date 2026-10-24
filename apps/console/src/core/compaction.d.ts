/**
 * COMPACTION (owner round 14, 2026-10-05): the context-fitting mechanic,
 * mirroring pi's design (docs aside, this is OUR implementation — pi's
 * compaction lives in the coding-agent package we don't depend on).
 *
 * THE CONTRACT: full history stays persisted in the record — extraction
 * and the user's transcript keep reading everything. A compaction marker
 * (LhMarkerMessage, customType "compaction") carries a summary plus the
 * cut (firstKeptMessageId); toLlmMessages — the ONE model-facing seam —
 * projects [summary] + [messages from the cut onward] on every request.
 * The live agent never holds dropped messages because every run is built
 * fresh from the record: question/problem poses terminate their runs, so
 * the "user is thinking" pause is always a BETWEEN-RUNS window —
 * compaction kicks at turn settle (running during the pause) and every
 * turn start awaits the gate. No mid-run surgery exists.
 *
 * Trigger threshold (owner ruling): effective = min(settings threshold,
 * model contextWindow − 16k reserve). Defaults: threshold 150k, kept
 * tail ~20k recent tokens (pi's defaults, owner-approved). Token
 * estimation follows pi's law (2026-10-05 incident fix): anchor on the
 * provider-reported usage of the last assistant message, chars/4 only
 * for messages appended after that anchor; the heuristic alone runs
 * only when no usage exists yet.
 *
 * Summary content (owner's three requirements + continuity): the
 * learner's understanding and its EVOLUTION (quiz outcomes, confidence,
 * misconceptions — a detailed picture of what the user knows), the
 * teaching arc / session progression, and the plan dependency tree
 * VERBATIM (from record.tree — the plan_init tool result may fall before
 * the cut, so the marker re-injects it). Plus the current moment (any
 * pending question/problem and the immediate next step) so the post-cut
 * model can continue mid-thought.
 */
import type { PlanTree } from "./contracts/plan.ts";
import type { LhMessage, LhMarkerMessage } from "./native-messages.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
/** Kept-recent tail budget (pi's default, owner-approved 2026-10-05):
 * ~20k tokens of verbatim recent transcript always ride after the
 * summary — recency is cheap insurance against summary loss. */
export declare const KEEP_RECENT_TOKENS = 20000;
/** The reserve subtracted from the model's contextWindow when the window
 * (not the user's threshold) is the binding constraint (pi's default). */
export declare const COMPACTION_RESERVE_TOKENS = 16384;
/** Factory default for the settings threshold (owner ruling: 150k). */
export declare const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 150000;
/** Context tokens from a provider-reported usage block — the most honest
 * measure of "what the last request actually carried." Mirrors pi's
 * calculateContextTokens. */
export declare function calculateContextTokens(usage: {
    totalTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
}): number;
/** Estimate a message's context tokens from its WIRE-relevant text only
 * (pi's estimator): text + thinking + toolCall name/args for assistants,
 * content text for user/toolResult/custom. NEVER JSON.stringify of the
 * whole message — record scaffolding (ids, usage, responseId, app-side
 * details, escaped quotes/backslashes) inflates ~3x (measured on the
 * 2026-10-05 relational-databases incident: 84k estimated vs ~30k real). */
export declare function estimateMessageTokens(message: LhMessage | AgentMessage): number;
/** The newest assistant message carrying VALID provider-reported usage
 * (pi's rule: skip aborted messages and all-zero usage — they carry no
 * truth about the wire). The scan STOPS at the newest compaction
 * marker: usage captured before a compaction described the pre-cut
 * context — the next request carries the summary + kept tail instead,
 * so pre-marker usage is not a valid anchor (pi's "don't trust usage
 * captured before a later compaction" law). Index into messages, or
 * null. */
export declare function lastAssistantUsageIndex(messages: readonly (LhMessage | AgentMessage)[]): number | null;
export interface ContextTokenEstimate {
    /** The estimate the trigger should compare against the threshold. */
    tokens: number;
    /** Provider-reported tokens from the usage anchor (0 when unanchored). */
    usageTokens: number;
    /** chars/4-estimated tokens after the anchor (or everything, unanchored). */
    trailingTokens: number;
    /** Index of the usage anchor, or null (diagnostics). */
    lastUsageIndex: number | null;
}
/** THE trigger estimator (pi's estimateContextTokens): anchor on the last
 * assistant usage the provider reported — prompt, tools, tokenizer
 * density and all — and chars/4-estimate ONLY what was appended after
 * it. The heuristic never re-estimates history the provider already
 * counted (the relational-databases bug: full-record JSON.stringify/4
 * tripled the true context and fired a 30k session at an 80k threshold). */
export declare function estimateContextTokens(messages: readonly (LhMessage | AgentMessage)[]): ContextTokenEstimate;
/** Estimate a whole message list (the plain heuristic — cut-walk use). */
export declare function estimateTokens(messages: readonly (LhMessage | AgentMessage)[]): number;
/**
 * Find the compaction cut index: walk BACKWARDS from the end accumulating
 * estimates until ~keepRecentTokens are kept; the cut lands there.
 *
 * HARD INVARIANT — a tool result is never separated from its call: if the
 * walk stops on a toolResult, the KEPT region extends to the assistant
 * message carrying its call (keeping the result means keeping the call).
 * This is the provider protocol's shape law: dropping a call while
 * keeping its result strands an orphan the provider rejects. A PENDING
 * question/problem call (no result yet — the pose→answer window) sits at
 * the transcript end and is always kept: the walk never crosses it.
 *
 * Returns 0 when everything must be summarized (the whole history is the
 * span — valid), or messages.length when there is nothing meaningful to
 * cut (kept budget covers everything — caller checks before compacting).
 */
export declare function compactionCutIndex(messages: readonly LhMessage[], keepRecentTokens?: number): number;
/** The compaction marker's details (UI payload — never model-visible;
 * the model sees content, the header + summary). */
export interface CompactionDetails {
    /** Record id of the first KEPT message: the projection renders the
     * summary, then everything from this message onward. */
    firstKeptMessageId: string;
    /** The estimated context tokens that triggered this compaction
     * (provenance for the divider's tooltip/dialog). */
    tokensBefore: number;
    /** provider:id of the model that wrote the summary (the session's
     * own model — owner ruling; provenance, never a routing input). */
    model?: string;
    /** ISO timestamp of the compaction moment. */
    at: string;
}
/** Build the compaction marker. Content is the FULL model-facing text
 * (header + summary — single-sourced header); the marker rides the
 * record at the compaction MOMENT (near the transcript end), while the
 * cut it names sits deep in history: the UI renders both places. */
export declare function newCompactionMarker(summary: string, details: CompactionDetails): LhMarkerMessage;
/** The ACTIVE compaction marker: the newest one in the record (chained
 * compactions — the last one rules; older markers fall inside the
 * dropped span and never render). */
export declare function activeCompactionOf(messages: readonly LhMessage[]): (LhMarkerMessage & {
    details: CompactionDetails;
}) | null;
/** The index of the first KEPT message, or -1 when the record's active
 * marker names an id that no longer exists (corrupt/foreign) — callers
 * fall back to rendering everything (honest degradation, never throw). */
export declare function keptIndexFor(messages: readonly LhMessage[], marker: LhMarkerMessage & {
    details: CompactionDetails;
}): number;
/** Serialize a message span as labeled text for the summarizer. Tool
 * results truncate at ~2k chars (the kept tail carries them verbatim for
 * the model; the SUMMARY only needs their gist). */
export declare function serializeForSummary(messages: readonly LhMessage[]): string;
/** Render the plan dependency tree verbatim (owner requirement: the tree
 * persists through compaction). Structure from record.tree, statuses
 * derived from the transcript (the record's own law: the tree carries
 * structure only). Empty tree → absent section (nothing persisted). */
export declare function planTreeToText(tree: PlanTree | undefined, messages: readonly LhMessage[]): string | null;
/**
 * The summarizer prompt. The summary's REQUIRED SHAPE (owner rulings):
 * the learner's understanding AND its evolution, the teaching arc, the
 * plan tree verbatim, and the current moment — in that order of stress.
 * The summarizer is the session's own model (owner ruling), writing for
 * its own future self: the summary replaces everything before the cut.
 */
export declare function buildCompactionPrompt(input: {
    /** The span to summarize, pre-serialized (serializeForSummary). */
    spanText: string;
    /** The plan tree rendered (planTreeToText) or null. */
    planTreeText: string | null;
    /** The session kind (wording: tutor vs practice agent). */
    kind: "teach" | "practice" | "probe";
}): string;
//# sourceMappingURL=compaction.d.ts.map