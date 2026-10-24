import { newHandoffMessage } from "../native-messages.ts";
/** pi-ai's Usage shape (input/output/cacheRead/cacheWrite/reasoning?) →
 * UsageStepLike. Structural — no pi import here; the engine band maps at
 * its boundaries. */
export function piUsageToStep(usage) {
    return {
        inputTokens: usage.input,
        outputTokens: usage.output,
        inputTokenDetails: { cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite },
        outputTokenDetails: usage.reasoning !== undefined ? { reasoningTokens: usage.reasoning } : undefined,
    };
}
/** Fold one model call's usage into the run's running total (pure). A
 * field neither the total nor the step reported stays undefined; once
 * reported, later unreported calls contribute 0. The `steps` counter is
 * the billing count: one per model call, reported or not. */
export function accumulateJobUsage(total, model, step) {
    const add = (a, b) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
    return {
        model,
        inputTokens: add(total?.inputTokens, step.inputTokens),
        outputTokens: add(total?.outputTokens, step.outputTokens),
        cacheReadTokens: add(total?.cacheReadTokens, step.inputTokenDetails?.cacheReadTokens),
        cacheWriteTokens: add(total?.cacheWriteTokens, step.inputTokenDetails?.cacheWriteTokens),
        reasoningTokens: add(total?.reasoningTokens, step.outputTokenDetails?.reasoningTokens),
        steps: (total?.steps ?? 0) + 1,
        lastStep: {
            inputTokens: step.inputTokens,
            outputTokens: step.outputTokens,
            cacheReadTokens: step.inputTokenDetails?.cacheReadTokens,
            cacheWriteTokens: step.inputTokenDetails?.cacheWriteTokens,
            reasoningTokens: step.outputTokenDetails?.reasoningTokens,
        },
    };
}
/** Set a steer message's ui.inverted (pure): returns a NEW message array
 *  with the target's details updated — no-op (same array) when the message
 *  is missing or not an invertible artifact steer. The silent route's
 *  whole body. */
export function setSteerUiInverted(messages, messageId, inverted) {
    return messages.map((m) => {
        if (m.id !== messageId)
            return m;
        const d = m.details;
        if (!d || (d.kind !== "demo" && d.kind !== "visual"))
            return m;
        return { ...m, details: { ...d, ui: { ...d.ui, inverted } } };
    });
}
/** Whether a result is the failure shape (html/svg empty, failure brief). */
export function isSubagentFailure(kind, result) {
    if (kind === "research") {
        const r = result;
        return r.sources.length === 0 && /^Research failed:/i.test(r.brief);
    }
    if (kind === "demo") {
        const r = result;
        return typeof r.html !== "string" || r.html.length === 0;
    }
    if (kind === "pdf") {
        const r = result;
        return /^PDF failed:/i.test(r.brief);
    }
    const r = result;
    return typeof r.svg !== "string" || r.svg.length === 0;
}
/** The model-facing text of a steer: what the result IS, what to do with it. */
function steerText(kind, result) {
    if (isSubagentFailure(kind, result)) {
        if (kind === "research")
            return `${result.brief}\n\nContinue with what you can establish and flag the uncertainty to the learner.`;
        if (kind === "demo")
            return `The demo "${result.title}" could not be built: ${result.notes ?? "unknown reason"}. Fall back to explaining in prose; if the brief was the problem, re-call demo with a tighter one.`;
        if (kind === "pdf")
            return `${result.brief}\n\nContinue with what you can establish from the session and flag the gap to the learner.`;
        return `The figure could not be made: ${result.notes ?? "unknown reason"}. Fall back to prose or mermaid, or re-call visual with a tighter brief.`;
    }
    if (kind === "research")
        return `Research complete — the researcher's full brief follows. Weave it into the lesson and cite its sources when you use its findings:\n\n${result.brief}`;
    if (kind === "pdf")
        return `PDF reading complete — the reader's brief on "${result.path}" follows, with page citations. Weave it into the lesson and cite pages when you use it:\n\n${result.brief}`;
    if (kind === "demo")
        return `The demo "${result.title}" is built, headlessly tested, and rendered in the lesson. Builder notes: ${result.notes ?? "(none)"}.\nTeach with it — reference its controls by name and point the learner at what to try.`;
    return `The figure is drawn, verified by inspection, and rendered in the lesson. Maker notes: ${result.notes ?? "(none)"}.\nReference its elements as you teach.`;
}
/**
 * Build the steer message for a finished job (pure — shared by the runner,
 * the wake pipeline, and tests). Deterministic id per job makes re-delivery
 * idempotent.
 */
export function buildSubagentSteer(job, result) {
    return {
        id: `steer_${job.id}`,
        role: "custom",
        customType: "subagent-steer",
        content: steerText(job.kind, result),
        display: true,
        details: {
            jobId: job.id,
            kind: job.kind,
            toolCallId: job.toolCallId,
            result,
        },
        timestamp: Date.now(),
    };
}
/** Build the abort steer for an aborted job (pure — shared by the
 * abort path in src/server/jobs.ts and tests). Same id space as the result
 * steer (same id space — exactly one delivers). */
export function buildAbortSteer(job) {
    const meta = { jobId: job.id, kind: job.kind, toolCallId: job.toolCallId, aborted: true };
    return {
        id: `steer_${job.id}`,
        role: "custom",
        customType: "subagent-abort",
        content: abortText(job.kind),
        display: true,
        details: meta,
        timestamp: Date.now(),
    };
}
/** What the teacher reads: one line telling it the result is not coming,
 * how to acknowledge, and that re-dispatching is allowed. */
function abortText(kind) {
    if (kind === "research")
        return "Research aborted — the learner aborted the research job, so no brief is coming. Acknowledge it in one line and continue teaching without it (or offer to re-dispatch it).";
    if (kind === "demo")
        return "The demo job was aborted by the learner — no demo is coming. Acknowledge it in one line and teach the topic in prose instead (a re-dispatch is fine if the learner wants it).";
    if (kind === "pdf")
        return "The PDF reading job was aborted by the learner — no brief is coming. Acknowledge it in one line and continue without it (a re-dispatch is fine if the learner wants it).";
    return "The figure job was aborted by the learner — no figure is coming. Acknowledge it in one line and teach without it (a re-dispatch is fine if the learner wants it).";
}
// ─── the probe handoff steer (the probe→teach split, docs/probe-teach-split.md §2) ──
//
// probe_done's execute queues this through the same wake pipeline; the
// pump fires it once the prober's turn ends (gates + grace). It carries no
// artifact — the assessment it references is durable in the transcript as
// the probe_done tool result. Deterministic id per chat: exactly one
// handoff, idempotent re-delivery. The marker's content is HANDOFF_TEXT
// (core/contracts/chat.ts — single source); the UI renders the quiet
// system line off the customType. Nothing human-looking is persisted, ever.
export function buildProbeHandoffSteer(chatId) {
    return newHandoffMessage(chatId);
}
/** True when the transcript already carries this steer — idempotent
 *  delivery for ANY steer kind: every steer id is deterministic per its
 *  event (steer_<jobId> for jobs, steer_probe_<chatId> for the handoff). */
export function steerDelivered(messages, steerId) {
    return messages.some((m) => m.id === steerId);
}
//# sourceMappingURL=jobs.js.map