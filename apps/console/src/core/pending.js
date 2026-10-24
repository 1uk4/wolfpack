function isToolUIPart(part) {
    return part.type.startsWith("tool-") && typeof part.toolCallId === "string";
}
/** Tools that render in the question dock and gate the composer. The
 *  probe-phase names (probe/recall, owner 2026-10-09) join their teach
 *  twins — old records keep the teach names; new probe-phase calls carry
 *  the phase names. */
export const QUESTION_TOOLS = [
    "quiz",
    "probe",
    "ask_user_question",
    "explain",
    "recall",
];
/** The tool→kind map (the dock's own fold, named once — the dismissal
 *  path and the dock must never disagree on what a tool is). The probe
 *  names fold onto their teach kinds — the dock is kind-driven. */
export function toolQuestionKind(tool) {
    return tool === "quiz" || tool === "probe" ? "quiz" : tool === "explain" || tool === "recall" ? "explain" : "ask";
}
/** Tools fulfilled by background sub-agent jobs (W2/W6). */
export const JOB_TOOLS = ["research", "demo", "visual"];
// ─── Tool availability (2026-09 settings seam) ─────────────────────────────
/** The tools a user may toggle off in settings — THE DEFINITIVE LIST
 *  (adjudicated 2026-09-19, P2 reconciliation: the sub-agent JOB tools
 *  only — research/demo/visual/pdf). Deliberately NOT toggleable, ever:
 *  quiz + ask_user_question (the prober's flow is graded-quiz brackets →
 *  probe_done; quiz-off would collapse the assessment and teaching
 *  doctrine is built on graded verification — the wedge danger), the
 *  learner-filesystem set (user-decided 2026-09, sources v1: always-on),
 *  plan tools, and probe_done (it is how the phase ENDS — a prober that
 *  can never conclude is a lockout).
 *  The write side validates against this list (settings-body.ts: unknown
 *  key = 400 with the supported list); the read-side sanitizer stays
 *  lenient for forward-compat. The names are the MODEL-FACING tool names
 *  (research, not researcher; pdf is the PDF-reader dispatch, sources v0
 *  2026-09). */
export const TOGGLEABLE_TOOLS = ["research", "demo", "visual", "pdf"];
/** The keys the settings WRITE side accepts in agent.tools: the plain
 *  toggleables PLUS the quizzing-mechanics switch (`explain: true` arms
 *  free-recall quizzing and drops the MC quiz — see quizMechanics in
 *  agent/tools.ts; owner 2026-09-27). `quiz` itself stays unwritable:
 *  mechanics-managed, never individually toggleable. */
export const WRITABLE_TOOL_KEYS = [...TOGGLEABLE_TOOLS, "explain"];
/** Drop every tool the resolved settings mark as disabled. The single
 *  filtering site every factory shares (prober/teacher). */
export function filterEnabledTools(tools, enabled) {
    if (!enabled)
        return tools;
    const out = {};
    for (const [name, tool] of Object.entries(tools)) {
        if (enabled[name] === false)
            continue;
        out[name] = tool;
    }
    return out;
}
function findPending(messages, names) {
    for (let m = messages.length - 1; m >= 0; m--) {
        const msg = messages[m];
        for (let p = 0; p < msg.parts.length; p++) {
            const part = msg.parts[p];
            if (isToolUIPart(part) && part.state === "input-available") {
                const tool = part.type.slice("tool-".length);
                if (names.includes(tool)) {
                    return { toolCallId: part.toolCallId, tool, input: part.input };
                }
            }
        }
    }
    return null;
}
export function findPendingToolCall(messages) {
    return findPending(messages, QUESTION_TOOLS);
}
// ─── Turn activity label (2026-09-19, the “Writing a question…” fix) ──────
/**
 * The transcript's turn-activity shimmer text: what the teacher is
 * doing RIGHT NOW. A tool part sits in `input-streaming` for its whole
 * execution (the bridge defers `tool-input-available` to
 * tool_execution_end — the invalid-input gate for the question dock), so
 * keying the old “Writing a question…” shimmer on ANY streaming tool
 * part mislabeled minutes-long local greps as question-writing. The label
 * now names the actual activity; chat.tsx gates it on `!pending` and
 * renders it as the quiet transcript shimmer.
 */
const ACTIVITY_LABELS = {
    read: "Reading a file…",
    ls: "Listing a directory…",
    find: "Finding files…",
    grep: "Searching file contents…",
    research: "Dispatching research…",
    demo: "Building a demo…",
    visual: "Making a visual…",
    pdf: "Reading a PDF…",
    plan_init: "Drawing up the plan…",
    probe_done: "Concluding the assessment…",
};
/** The activity label for ONE running tool (owner, streaming round
 *  2026-10-01): the live tool-input card carries it inline — spinner +
 *  shimmered label on the card itself, replacing the retired transcript
 *  bottom line. Question tools are excluded here: their input-streaming
 *  part renders in the dock, never a live card. */
export function toolActivityLabel(tool) {
    if (QUESTION_TOOLS.includes(tool))
        return "Writing a question…";
    return ACTIVITY_LABELS[tool] ?? "Working…";
}
export function streamingToolActivity(messages) {
    const last = messages.at(-1);
    if (!last || last.role !== "assistant")
        return null;
    for (const part of last.parts) {
        if (isToolUIPart(part) && part.state === "input-streaming") {
            return toolActivityLabel(part.type.slice("tool-".length));
        }
    }
    return null;
}
//# sourceMappingURL=pending.js.map