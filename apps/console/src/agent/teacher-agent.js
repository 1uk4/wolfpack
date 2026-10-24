import { Agent } from "@earendil-works/pi-agent-core";
import { invalidInputResult, questionResult } from "./tool-execute.ts";
import { providerEventObserver } from "./provider-events.ts";
import { APP_IDENTITY, piEngineFor } from "./models.ts";
import { effectivePromptSegments } from "./prompt-segments.ts";
import { askUserQuestionTool, createProberTools, createTeacherTools, } from "./tools.ts";
import { practiceTools } from "./tools/practice.ts";
import { healToolRecord } from "./tools/heal.ts";
import { quizInputObject, quizInputProblems } from "../core/question-core.ts";
import { QUESTION_TOOLS } from "../core/pending.ts";
import { toLlmMessages } from "../core/native-messages.ts";
// P2 (2026-09-19): segment discovery + override resolution live in ONE
// canonical place now — src/store/prompt-overrides.ts (listSourceSegments
// mirrors this loader's rules, shared/ included). The agent imports it for
// the static-file seam; the local fragment discovery helpers are retired.
/** Exported for tests: assert what composes into the model's prompt.
 *  Composition order: shared base → shared/ fragments (both agents, the
 *  sources-v1 seam for cross-agent doctrine) → the agent's own fragments.
 *
 *  P2 reconciliation (2026-09-19): composition is DELEGATED to the store
 *  module's effectivePromptSegments — one canonical segment-discovery
 *  rule (its listSourceSegments mirrors this loader's, now including
 *  shared/) — so per-segment OVERRIDES ride the same path: a segment
 *  whose switch is ON and whose override file exists composes the
 *  override text instead of the source. `switches` is the settings
 *  record's agent.prompts map (absent key = off), threaded per turn via
 *  AgentBuildOptions.promptSwitches; a switches-less call composes pure
 *  source (byte-identical to the pre-refactor loader — pinned in
 *  tests/prompt-overrides.test.ts). Overrides are a static-file read
 *  through config paths, not request state — the store import carries no
 *  chat/job machinery. */
export function composeInstructions(kind, switches) {
    const segments = effectivePromptSegments(kind, switches ?? {});
    return segments
        .map((s) => (s.enabled ? s.overrideText : s.sourceText))
        .map((t) => t.trim())
        .filter(Boolean)
        .join("\n\n---\n\n");
}
// The switch-free source composition, cached per kind (module-load once).
// With promptSwitches provided, baseAgentOptions composes FRESH per turn —
// an override file written while its switch is ON must flip the next
// turn's composition; the cache serves only the switches-less path.
const composedInstructions = {
    prober: composeInstructions("prober"),
    teacher: composeInstructions("teacher"),
    practice: composeInstructions("practice"),
};
/**
 * The turn's question-stop rule (docs/pi-engine-swap.md §2; Wave A
 * 2026-09-26, owner Option A): a question tool call (quiz /
 * ask_user_question) that RESOLVED — its synthetic "question posed" result
 * is not an error — ends the run: the learner's answer arrives as the next
 * POST. A call that FAILED authoring validation (error result) must NOT
 * stop the run — the model retries within the same turn, exactly the old
 * InvalidToolInputError semantics.
 *
 * Question results also carry terminate: true (tool-execute's
 * questionResult), so single-question batches stop natively at the pi
 * loop's own batch check; this finishTurn hook (0.87.1 rename of
 * shouldStopAfterTurn) is the
 * belt-and-suspenders HALF for the mixed batch (a question + other calls
 * in one message) that terminate-only semantics would let run on — the
 * learner cannot answer while a turn is in flight (per-chat 409), so a
 * cleanly-posed question MUST always end the turn. maxTurns is gone
 * (owner ruling 2026-09-25: no maximum-agent-turns net on the teaching
 * turn).
 */
function makeQuestionStopper() {
    return (context) => {
        const called = new Set(context.message.content
            .filter((c) => c.type === "toolCall" && c.name !== undefined && QUESTION_TOOLS.includes(c.name))
            .map((c) => c.id));
        if (called.size === 0)
            return false;
        // Stop only when every question call of this turn resolved cleanly.
        for (const result of context.toolResults) {
            if (called.has(result.toolCallId) && result.isError)
                return false;
        }
        return true;
    };
}
function baseAgentOptions(kind, opts, tools) {
    // Practice never reaches the role fallback (the handler ALWAYS injects
    // the session's conversation engine — practice rides the same
    // conversation-spec resolution as teaching); the cast keeps AgentKind
    // ("practice" is not a ModelRole) honest about that.
    const engine = opts.engine ?? piEngineFor(kind);
    const stopper = makeQuestionStopper();
    const systemPrompt = opts.promptSwitches
        ? composeInstructions(kind, opts.promptSwitches)
        : composedInstructions[kind];
    // Debug recorder (owner, 2026-10-04): raw provider events when
    // LH_PROVIDER_EVENTS=1 and the caller handed a chatId; undefined is
    // the normal no-observer path (tests, env-off).
    const providerEvents = opts.chatId ? providerEventObserver(opts.chatId, kind) : undefined;
    const agent = new Agent({
        identity: APP_IDENTITY,
        sessionId: opts.chatId,
        initialState: {
            systemPrompt,
            model: engine.model,
            thinkingLevel: engine.level,
            tools,
            messages: opts.messages ?? [],
        },
        streamFn: engine.streamFn,
        ...(providerEvents ? { onProviderStreamEvent: providerEvents } : {}),
        // 0.87.1: shouldStopAfterTurn → finishTurn. Same call point (after
        // tool results attach, before turn_end) and `{ action: "end" }` still
        // exits BEFORE the steering poll — the parked-marker stranding our
        // Wave C registerLiveAgent-before-runPiTurn design depends on.
        // undefined preserves normal scheduling (the old boolean false).
        finishTurn: (turn) => (stopper(turn) ? { action: "end" } : undefined),
        // Wave C (2026-09-26, owner correction same day): markers handed to a
        // live run drain from pi's STEERING queue — the lesson loop is one
        // continuous teach→quiz→teach run, so delivery must inject at turn
        // boundaries INSIDE the run, not wait for it to stop (follow-ups).
        // "all" joins every handed marker at one boundary, matching the idle
        // wake's carry-everything semantics (the default "one-at-a-time"
        // would spend one teacher turn per marker).
        steeringMode: "all",
        // Wave B (owner-approved 2026-09-26): the model-facing conversion is
        // THE app seam — markers flatten to their canonical user text
        // (HANDOFF_TEXT / steer text, all single-sourced),
        // UI-only markers (plan-block) drop, the app's id fields strip, and
        // an abort's dangling question call gets its INTERRUPTED result. It
        // must never throw (pi's convertToLlm contract).
        convertToLlm: toLlmMessages,
    });
    if (opts.onUsage) {
        agent.subscribe((event) => {
            if (event.type === "message_end" && event.message.role === "assistant" && "usage" in event.message) {
                // A cancelled call is not a billed step (partial/estimated
                // usage on an aborted message is not money spent).
                if (event.message.stopReason === "aborted")
                    return;
                opts.onUsage(event.message.usage);
            }
        });
    }
    return agent;
}
/**
 * The PROBER (agent A): the quizzing tool (quiz, or explain under free
 * recall — no nodeId either way) + ask + probe_done, lean on
 * probing doctrine. Its whole job is bracketing the learner's edge and
 * concluding with the assessment (probe_done) — which also queues the
 * handoff wake (see tools/probe.ts) and is the transcript seam the
 * handler keys teacher construction on.
 */
export function createProberAgent(ctx, opts = {}) {
    return baseAgentOptions("prober", opts, Object.values(createProberTools(ctx, opts.toolToggles)));
}
/**
 * The TEACHER (agent B): enters at planning (the probe is already
 * concluded — its assessment is in the transcript), owns plan_init and the
 * full toolset (teach questions with validated nodeId, the map, research,
 * demos).
 */
export function createTeacherAgent(
// Optional so tests can construct a bare mock-driven agent (no storage
// wiring): without ctx the tools fall back to the validation-free
// question set. The handler ALWAYS passes ctx (the composition root).
ctx, opts = {}) {
    const tools = opts.tools ?? (ctx ? createTeacherTools(ctx, opts.toolToggles) : bareQuestionTools());
    return baseAgentOptions("teacher", opts, Object.values(tools));
}
/** The bare teach question set (tests, bare agents): quiz with the shared
 *  authoring refinement (quizInputProblems, run in execute — returns an
 *  invalidInputResult isError result the model retries on, pi 1.0
 *  convention) but NO per-session nodeId check (no record to read),
 *  plus ask. */
export function bareQuestionTools() {
    // A typed const (not an inline literal): the specific AgentTool typing
    // gives execute its precise Static input; heterogeneous records take
    // AgentTool<any>, whose loose Static would smudge it to unknown.
    const quiz = {
        name: "quiz",
        label: "quiz",
        description: "Ask the learner a graded question.",
        parameters: quizInputObject,
        executionMode: "sequential",
        execute: async (_toolCallId, input) => {
            const problems = quizInputProblems(input);
            if (problems.length > 0)
                return invalidInputResult("quiz", problems);
            return questionResult();
        },
    };
    // healToolRecord (owner, 2026-10-09 — the whitehead generalization):
    // the bare quiz carried NO prepareArguments at all — not even the
    // options-unwrap; now it gets the full standard heal like every tool.
    return healToolRecord({
        quiz,
        ask_user_question: askUserQuestionTool,
    });
}
/**
 * The PRACTITIONER (practice sessions, owner design 2026-10-04): built
 * from turn 1 of a kind:"practice" session — no prober→teacher split,
 * no plan tools, no question tools. Its ENTIRE registry is
 * problem + conclude (tools/practice.ts); the doctrine prompt
 * (prompts/practice/) carries the method. The question-stop rule does
 * not apply (problem rides terminate: true natively —
 * QUESTION_TOOLS does not include it), so baseAgentOptions's stopper is
 * a no-op here; it stays wired for uniformity.
 */
export function createPracticeAgent(ctx, opts = {}) {
    const tools = opts.tools ?? practiceTools(ctx);
    return baseAgentOptions("practice", opts, Object.values(tools));
}
//# sourceMappingURL=teacher-agent.js.map