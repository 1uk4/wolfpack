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
import { derivePlanStatusesLh, derivedNodeStatus } from "./contracts/plan.ts";
import { COMPACTED_HISTORY_HEADER } from "./contracts/chat.ts";
import { newMessageId } from "./native-messages.ts";
// ─── constants (the tunables, owner-approved) ────────────────────────────────
/** Kept-recent tail budget (pi's default, owner-approved 2026-10-05):
 * ~20k tokens of verbatim recent transcript always ride after the
 * summary — recency is cheap insurance against summary loss. */
export const KEEP_RECENT_TOKENS = 20_000;
/** The reserve subtracted from the model's contextWindow when the window
 * (not the user's threshold) is the binding constraint (pi's default). */
export const COMPACTION_RESERVE_TOKENS = 16_384;
/** Factory default for the settings threshold (owner ruling: 150k). */
export const DEFAULT_COMPACTION_THRESHOLD_TOKENS = 150_000;
/** Tool-result truncation when serializing the span for the summarizer
 * (pi's mirror: long job/research results don't need verbatim inclusion
 * in the SUMMARY INPUT — the kept tail carries them whole). */
const SUMMARY_TOOL_RESULT_TRUNCATE = 2_000;
// ─── token estimation (pi's law: usage-anchored, chars/4 only for the tail) ─
/** Context tokens from a provider-reported usage block — the most honest
 * measure of "what the last request actually carried." Mirrors pi's
 * calculateContextTokens. */
export function calculateContextTokens(usage) {
    return (usage.totalTokens ||
        (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
}
/** Estimate a message's context tokens from its WIRE-relevant text only
 * (pi's estimator): text + thinking + toolCall name/args for assistants,
 * content text for user/toolResult/custom. NEVER JSON.stringify of the
 * whole message — record scaffolding (ids, usage, responseId, app-side
 * details, escaped quotes/backslashes) inflates ~3x (measured on the
 * 2026-10-05 relational-databases incident: 84k estimated vs ~30k real). */
export function estimateMessageTokens(message) {
    const content = message.content;
    let chars = 0;
    if (message.role === "assistant") {
        for (const block of (Array.isArray(content) ? content : [])) {
            if (block.type === "text")
                chars += block.text?.length ?? 0;
            else if (block.type === "thinking")
                chars += block.thinking?.length ?? 0;
            else if (block.type === "toolCall")
                chars += (block.name?.length ?? 0) + JSON.stringify(block.arguments ?? {}).length;
        }
    }
    else {
        chars += textCharsOfContent(content);
    }
    return Math.ceil(chars / 4);
}
function textCharsOfContent(content) {
    if (typeof content === "string")
        return content.length;
    if (!Array.isArray(content))
        return 0;
    let chars = 0;
    for (const block of content) {
        if (typeof block === "string")
            chars += block.length;
        else if (block?.type === "text" || "text" in block)
            chars += block.text?.length ?? 0;
    }
    return chars;
}
/** The newest assistant message carrying VALID provider-reported usage
 * (pi's rule: skip aborted messages and all-zero usage — they carry no
 * truth about the wire). The scan STOPS at the newest compaction
 * marker: usage captured before a compaction described the pre-cut
 * context — the next request carries the summary + kept tail instead,
 * so pre-marker usage is not a valid anchor (pi's "don't trust usage
 * captured before a later compaction" law). Index into messages, or
 * null. */
export function lastAssistantUsageIndex(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === "custom" && m.customType === "compaction")
            return null;
        if (m.role !== "assistant")
            continue;
        const a = m;
        if (a.stopReason === "aborted")
            continue;
        if (calculateContextTokens((a.usage ?? {})) === 0)
            continue;
        return i;
    }
    return null;
}
/** THE trigger estimator (pi's estimateContextTokens): anchor on the last
 * assistant usage the provider reported — prompt, tools, tokenizer
 * density and all — and chars/4-estimate ONLY what was appended after
 * it. The heuristic never re-estimates history the provider already
 * counted (the relational-databases bug: full-record JSON.stringify/4
 * tripled the true context and fired a 30k session at an 80k threshold). */
export function estimateContextTokens(messages) {
    const anchor = lastAssistantUsageIndex(messages);
    if (anchor === null) {
        let trailing = 0;
        for (const m of messages)
            trailing += estimateMessageTokens(m);
        return { tokens: trailing, usageTokens: 0, trailingTokens: trailing, lastUsageIndex: null };
    }
    const anchored = messages[anchor];
    const usageTokens = calculateContextTokens(anchored.usage);
    let trailing = 0;
    for (let i = anchor + 1; i < messages.length; i++)
        trailing += estimateMessageTokens(messages[i]);
    return { tokens: usageTokens + trailing, usageTokens, trailingTokens: trailing, lastUsageIndex: anchor };
}
/** Estimate a whole message list (the plain heuristic — cut-walk use). */
export function estimateTokens(messages) {
    let total = 0;
    for (const m of messages)
        total += estimateMessageTokens(m);
    return total;
}
// ─── the cut walk ────────────────────────────────────────────────────────────
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
export function compactionCutIndex(messages, keepRecentTokens = KEEP_RECENT_TOKENS) {
    let kept = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (kept >= keepRecentTokens) {
            // The cut candidate: extend past orphaned tool results to the
            // assistant message carrying their calls.
            let cut = i + 1;
            while (cut < messages.length && messages[cut].role === "toolResult") {
                const callIndex = assistantIndexOfCall(messages, messages[cut].toolCallId, cut);
                if (callIndex === -1)
                    break; // no call found (defensive): stop extending
                cut = callIndex;
            }
            return cut;
        }
        kept += estimateMessageTokens(messages[i]);
    }
    return 0; // the whole history fits inside the kept budget — summarize all
}
/** The newest assistant message at or before `before` whose content
 * carries the tool call `toolCallId` — the call a result answers. */
function assistantIndexOfCall(messages, toolCallId, before) {
    for (let i = before - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "assistant")
            continue;
        const assistant = m;
        if (assistant.content.some((b) => b.type === "toolCall" && b.id === toolCallId))
            return i;
    }
    return -1;
}
/** Build the compaction marker. Content is the FULL model-facing text
 * (header + summary — single-sourced header); the marker rides the
 * record at the compaction MOMENT (near the transcript end), while the
 * cut it names sits deep in history: the UI renders both places. */
export function newCompactionMarker(summary, details) {
    return {
        id: newMessageId(),
        role: "custom",
        customType: "compaction",
        content: `${COMPACTED_HISTORY_HEADER}\n\n${summary.trim()}`,
        display: true,
        details,
        timestamp: Date.now(),
    };
}
/** The ACTIVE compaction marker: the newest one in the record (chained
 * compactions — the last one rules; older markers fall inside the
 * dropped span and never render). */
export function activeCompactionOf(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role !== "custom")
            continue;
        const marker = m;
        if (marker.customType === "compaction") {
            const details = marker.details;
            if (typeof details.firstKeptMessageId === "string") {
                return marker;
            }
        }
    }
    return null;
}
/** The index of the first KEPT message, or -1 when the record's active
 * marker names an id that no longer exists (corrupt/foreign) — callers
 * fall back to rendering everything (honest degradation, never throw). */
export function keptIndexFor(messages, marker) {
    const id = marker.details.firstKeptMessageId;
    for (let i = 0; i < messages.length; i++) {
        if (messages[i].id === id)
            return i;
    }
    return -1;
}
// ─── the summarizer input (pi's mirror: labeled text, truncated results) ─────
/** Serialize a message span as labeled text for the summarizer. Tool
 * results truncate at ~2k chars (the kept tail carries them verbatim for
 * the model; the SUMMARY only needs their gist). */
export function serializeForSummary(messages) {
    const lines = [];
    for (const m of messages) {
        const role = m.role;
        if (role === "user") {
            lines.push(`[LEARNER] ${m.content}`);
        }
        else if (role === "assistant") {
            const assistant = m;
            const blocks = [];
            for (const b of assistant.content) {
                if (b.type === "text")
                    blocks.push(b.text);
                else if (b.type === "toolCall")
                    blocks.push(`(tool call ${b.name}: ${JSON.stringify(b.arguments)})`);
                // thinking blocks: the model's private scratch — its
                // conclusions land in text; skip the noise
            }
            if (blocks.length > 0)
                lines.push(`[TUTOR] ${blocks.join("\n")}`);
        }
        else if (role === "toolResult") {
            const result = m;
            const text = result.content
                .map((c) => (c.type === "text" ? c.text : JSON.stringify(c)))
                .join("\n");
            lines.push(`[RESULT for ${result.toolName}${result.isError ? " (error)" : ""}] ${text.length > SUMMARY_TOOL_RESULT_TRUNCATE ? `${text.slice(0, SUMMARY_TOOL_RESULT_TRUNCATE)}…[truncated]` : text}`);
        }
        else if (role === "custom") {
            const marker = m;
            if (marker.customType === "plan-block")
                continue; // UI-only
            lines.push(`[SYSTEM NOTE] ${marker.content}`);
        }
    }
    return lines.join("\n\n");
}
/** Render the plan dependency tree verbatim (owner requirement: the tree
 * persists through compaction). Structure from record.tree, statuses
 * derived from the transcript (the record's own law: the tree carries
 * structure only). Empty tree → absent section (nothing persisted). */
export function planTreeToText(tree, messages) {
    if (!tree || tree.nodes.length === 0)
        return null;
    const statuses = derivePlanStatusesLh(tree, messages);
    const byId = new Map(tree.nodes.map((n) => [n.id, n]));
    const lines = [];
    for (const node of tree.nodes) {
        const status = derivedNodeStatus(statuses, node.id);
        const summary = node.summary ? ` — ${node.summary}` : "";
        lines.push(`- [${status}] ${node.title} (${node.id})${summary}`);
    }
    for (const edge of tree.edges) {
        const from = byId.get(edge.from);
        const to = byId.get(edge.to);
        if (from && to)
            lines.push(`- ${from.title} → ${to.title} (${from.id} → ${to.id})`);
    }
    return lines.join("\n");
}
/**
 * The summarizer prompt. The summary's REQUIRED SHAPE (owner rulings):
 * the learner's understanding AND its evolution, the teaching arc, the
 * plan tree verbatim, and the current moment — in that order of stress.
 * The summarizer is the session's own model (owner ruling), writing for
 * its own future self: the summary replaces everything before the cut.
 */
export function buildCompactionPrompt(input) {
    const planSection = input.planTreeText ?? "No plan tree exists in this session (nothing was persisted).";
    return `You are compacting the earlier part of a tutoring session — writing the summary your future self will read INSTEAD of that transcript. Everything before the cut is replaced by what you write; everything after stays verbatim. The learner's transcript below labels the learner as [LEARNER], the tutoring agent as [TUTOR], tool traffic as [RESULT …]/[SYSTEM NOTE].

Write the summary with EXACTLY these sections, in this order:

## The learner's understanding
The most detailed picture you can give of what this learner knows and how that EVOLVED across the session: what they answered and how well (quiz outcomes, correct reasoning, mistakes), their stated or displayed confidence, misconceptions that surfaced, which were corrected and which still stand. This section carries the most weight — future teaching decisions hang on it.

## The teaching arc
How the session progressed: what was covered and in what order, which explanations landed and which didn't, how the learner responded, where the momentum went. Include probe-phase findings if present.

## The plan dependency tree
Reproduce the session's current plan tree verbatim from the structure below — do not drop nodes, edges, or statuses.

${planSection}

## The current moment
What is happening RIGHT NOW at the cut: any question or problem awaiting the learner's answer, any commitment the agent has made that a later turn must honor, and the immediate next step.

Rules: no praise, no filler, no speculation beyond the transcript. Every claim about the learner must be traceable to what they actually said or answered. Keep every identifier (proposition ids, node ids, file paths) exact.

TRANSCRIPT TO SUMMARIZE:

${input.spanText}`;
}
//# sourceMappingURL=compaction.js.map