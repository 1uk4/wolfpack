/**
 * Session → markdown — the ONE formatting engine (owner ruling 2026-09-27).
 *
 * The extractor's view of a teaching session and the future user-facing
 * session export share this engine: a session is rendered as clean,
 * readable markdown — speaker headers, quiz/check-in blocks, tool notes —
 * with optional message-id anchors. Since the submit-schema slim
 * (2026-09-28) propositions no longer report message ids — the extractor
 * renders anchorless and provenance is chat-level — so the anchors today
 * serve only the future user-facing export; `anchors: false` mints the
 * same document without them.
 *
 * Pure core: native messages in (LhMessage), string out. Content parity
 * with the coverage line builder (core/coverage.ts messageViewLines) is
 * deliberate — every message that produces view lines produces a markdown
 * block, in the same order — but the formats are SEPARATE by design
 * (2026-09-27): coverage fingerprints hash the line format and stay stable
 * (no mass re-extraction when presentation changes); markdown is
 * presentation. A failed tool call renders nothing (retry context, not
 * learning evidence); custom markers are invisible, same as the view.
 */
import { PRACTICE_CONCLUDE_TOOL, PRACTICE_PROBLEM_TOOL, problemInputForConclude, } from "./native-messages.ts";
/** The user-facing text blocks of a native message (string or text parts). */
function textOf(content) {
    if (typeof content === "string")
        return content.trim() ? [content] : [];
    if (!Array.isArray(content))
        return [];
    return content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .filter((t) => t.trim().length > 0);
}
function markdownContext(messages) {
    const calls = new Map();
    for (const message of messages) {
        if (message.role !== "assistant")
            continue;
        const content = message.content;
        if (!Array.isArray(content))
            continue;
        for (const part of content) {
            const block = part;
            if (block.type === "toolCall" && typeof block.id === "string") {
                calls.set(block.id, {
                    name: typeof block.name === "string" ? block.name : "",
                    args: (block.arguments ?? undefined),
                });
            }
        }
    }
    return { messages, calls };
}
/** solvedWithHints → "Solved with hints" — the outcome enum reads as prose. */
function outcomeLabel(outcome) {
    const spaced = outcome.replace(/([a-z])([A-Z])/g, (_, lo, hi) => `${lo} ${hi.toLowerCase()}`);
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
/** One tool result's learner-visible outcome, rendered as body lines. */
function toolResultBody(result, ctx) {
    const out = result.details;
    if (result.toolName === "quiz" ||
        result.toolName === "probe" ||
        result.toolName === "explain" ||
        result.toolName === "recall") {
        const heading = result.toolName === "quiz"
            ? "Quiz"
            : result.toolName === "probe"
                ? "Probe"
                : result.toolName === "recall"
                    ? "Recall"
                    : "Recall check"; // explain — the teach free-recall name
        const question = typeof out?.questionText === "string" && out.questionText ? out.questionText : "(no question text)";
        const body = [`**Q:** ${question}`];
        if (out?.dismissed === true)
            body.push("The learner skipped this check.");
        else if (out?.dontKnow === true)
            body.push("The learner did not know.");
        else if (out?.correct === true)
            body.push("The learner answered correctly.");
        else if (out?.correct === false)
            body.push("The learner answered incorrectly.");
        else if (typeof out?.text === "string" && out.text.trim())
            body.push(`The learner answered in his own words: ${out.text.trim()}`);
        if (typeof out?.note === "string" && out.note)
            body.push(`*(his thinking: ${out.note})*`);
        return { heading, body };
    }
    if (ctx !== undefined && result.toolName === PRACTICE_PROBLEM_TOOL) {
        const statement = ctx.calls.get(result.toolCallId)?.args?.statement;
        return {
            heading: "Problem",
            body: [typeof statement === "string" && statement.trim() ? statement.trim() : "(no statement)"],
        };
    }
    if (ctx !== undefined && result.toolName === PRACTICE_CONCLUDE_TOOL) {
        const args = ctx.calls.get(result.toolCallId)?.args;
        const outcome = typeof args?.outcome === "string" && args.outcome.trim() ? args.outcome.trim() : "";
        const verdict = typeof args?.verdict === "string" && args.verdict.trim() ? args.verdict.trim() : undefined;
        if (outcome === "dismissed")
            return { heading: "Concluded", body: ["The learner skipped this problem."] };
        const label = outcome !== "" ? `**${outcomeLabel(outcome)}.**` : "**Concluded.**";
        const body = [verdict !== undefined ? `${label} ${verdict}` : label];
        // The reveal (owner round, 2026-10-05): the solution committed at
        // pose time — the newest cleanly-posed problem before this conclude.
        const input = problemInputForConclude(ctx.messages, result.toolCallId);
        const solution = typeof input?.modelSolution === "string" && input.modelSolution.trim() ? input.modelSolution.trim() : undefined;
        if (solution !== undefined)
            body.push(`> **Model solution**\n>\n> ${solution.replace(/\n/g, "\n> ")}`);
        return { heading: "Concluded", body };
    }
    if (result.toolName === "ask_user_question") {
        const question = typeof out?.questionText === "string" && out.questionText ? out.questionText : "(no question text)";
        const body = [`**Q:** ${question}`];
        const chosen = [
            ...(Array.isArray(out?.answers) ? out.answers : []),
            ...(typeof out?.other === "string" && out.other.trim() ? [out.other.trim()] : []),
        ];
        if (typeof out?.text === "string" && out.text.trim())
            body.push(`The learner answered: ${out.text.trim()}`);
        else if (chosen.length > 0)
            body.push(`The learner chose: ${chosen.join(", ")}`);
        else if (out?.dismissed === true)
            body.push("The learner skipped this question.");
        if (typeof out?.note === "string" && out.note)
            body.push(`*(his thinking: ${out.note})*`);
        return { heading: "Question", body };
    }
    // Parity with the line builder: other clean tool results are one line.
    return { heading: "Tool", body: [`*${result.toolName} result delivered*`] };
}
/**
 * ONE message as a markdown block — `null` when the message renders
 * nothing (a failed tool call, a bare marker, an empty text part set).
 * `mid` is the provenance anchor shown when `anchors` is on.
 */
export function messageMarkdown(message, mid, anchors = true, ctx) {
    const role = message.role;
    const anchor = anchors ? ` · ${mid}` : "";
    const parts = [];
    if (role === "user") {
        for (const text of textOf(message.content)) {
            parts.push(`### Learner${anchor}\n\n${text.trim()}`);
        }
    }
    else if (role === "assistant") {
        for (const text of textOf(message.content)) {
            parts.push(`### Teacher${anchor}\n\n${text.trim()}`);
        }
    }
    else if (role === "toolResult") {
        const result = message;
        if (result.isError)
            return null; // retry context, not learning evidence
        const { heading, body } = toolResultBody(result, ctx);
        parts.push(`### ${heading}${anchor}\n\n${body.join("\n\n")}`);
    }
    // custom markers are invisible, same as the extraction view.
    return parts.length > 0 ? parts.join("\n\n") : null;
}
/**
 * A whole session (or one extraction BATCH — same engine, subset of
 * messages) as one markdown document. Blocks render in message order;
 * messages that render nothing are skipped silently. The optional title
 * mints the document header (`# <title>`).
 */
export function sessionMarkdown(messages, opts = {}) {
    const blocks = [];
    if (opts.title !== undefined && opts.title.length > 0)
        blocks.push(`# ${opts.title}`);
    const ctx = markdownContext(messages);
    for (const message of messages) {
        const block = messageMarkdown(message, message.id ?? "", opts.anchors ?? true, ctx);
        if (block !== null)
            blocks.push(block);
    }
    return blocks.join("\n\n");
}
//# sourceMappingURL=session-markdown.js.map