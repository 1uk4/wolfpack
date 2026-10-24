import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import { type PiEngine } from "./models.ts";
import { type ProberToolContext, type TeacherToolContext } from "./tools.ts";
import { type PracticeToolContext } from "./tools/practice.ts";
import { type EnabledTools } from "../core/pending.ts";
/**
 * The two teaching-side agents (docs/probe-teach-split.md): the PROBER and
 * the TEACHER. Same transcript, different prompts and tool sets; the
 * chat-handler constructs ONE per request off the transcript's seam
 * (probe_done = teacher) — the STATELESS per-turn engine (docs/
 * pi-engine-swap.md §2): the persisted record is the source of truth, the
 * agent is rebuilt from it every POST and discarded at turn end.
 *
 * Engines are injectable so tests can pass a scripted faux engine and drive
 * deterministic lessons (see tests/chat-flow.test.ts).
 *
 * System prompts are COMPOSED per agent: system-prompt.md (the shared base:
 * agent, voice, philosophy, accuracy) + every numeric-prefix fragment in
 * that agent's directory (src/agent/prompts/prober/ or
 * src/agent/prompts/teacher/), in sorted filename order, then the shared/
 * fragments as a trailing appendix (question tools, learner files,
 * formatting) — the 2026-09-27 reorder: the agent's job and method lead,
 * the mechanics trail. Joined with `---` separators.
 *
 * ONLY numeric-prefix files load — the loader enforces the convention, so
 * non-fragment documentation (README.md, …) can live in the directories
 * without ever leaking into the model's prompt.
 */
/** Which agent's prompt directory to compose. Practice (2026-10-04)
 *  composes ONLY its own directory — see prompt-segments.ts. */
export type AgentKind = "prober" | "teacher" | "practice";
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
export declare function composeInstructions(kind: AgentKind, switches?: Record<string, boolean>): string;
export type StepUsageCollector = (usage: Usage) => void;
/** Per-request construction options (the handler wires all of these). */
export interface AgentBuildOptions {
    /** Model + stream function — tests inject a scripted faux engine. */
    engine?: PiEngine;
    /** The initial transcript, as pi messages (the record IS agent state). */
    messages?: AgentMessage[];
    /** Money channel: one call per model request. */
    onUsage?: StepUsageCollector;
    /** Tests may pass a bare tool registry to drive deterministic flows.
     *  An explicit registry is NEVER toggle-filtered — the caller owns it. */
    tools?: Record<string, AgentTool<any>>;
    /** The resolved per-user tool toggles (core/pending EnabledTools — the
     *  2026-09-19 P2 bridge: Platform's chat-handler passes
     *  effective.agent.tools; the factories drop any tool explicitly false.
     *  THE DEFINITIVE toggleable set is TOGGLEABLE_TOOLS (job tools only);
     *  the filtering is generic, but writes validate against the list). */
    toolToggles?: EnabledTools;
    /** Per-segment system-prompt override SWITCHES (the settings record's
     *  agent.prompts map, absent key = off — same keys the settings routes
     *  and effectivePromptSegments use). Provided → the prompt composes
     *  fresh per turn, honoring enabled overrides (switch on + file
     *  exists); absent → the cached pure-source composition. */
    promptSwitches?: Record<string, boolean>;
    /** Native conversation identity: the existing persisted chat id, reused
     * across reconstructed prober, teacher, and practice Agents.
     * Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream events
     *  (pre-normalization) append to data/debug/provider-events/
     *  <chatId>.jsonl via providerEventObserver — the GLM-truncation /
     *  DeepSeek-id incident layer. Absent or env-off → no observer. */
    chatId?: string;
}
/**
 * The PROBER (agent A): the quizzing tool (quiz, or explain under free
 * recall — no nodeId either way) + ask + probe_done, lean on
 * probing doctrine. Its whole job is bracketing the learner's edge and
 * concluding with the assessment (probe_done) — which also queues the
 * handoff wake (see tools/probe.ts) and is the transcript seam the
 * handler keys teacher construction on.
 */
export declare function createProberAgent(ctx: ProberToolContext, opts?: AgentBuildOptions): any;
/**
 * The TEACHER (agent B): enters at planning (the probe is already
 * concluded — its assessment is in the transcript), owns plan_init and the
 * full toolset (teach questions with validated nodeId, the map, research,
 * demos).
 */
export declare function createTeacherAgent(ctx?: TeacherToolContext, opts?: AgentBuildOptions): any;
/** The bare teach question set (tests, bare agents): quiz with the shared
 *  authoring refinement (quizInputProblems, run in execute — returns an
 *  invalidInputResult isError result the model retries on, pi 1.0
 *  convention) but NO per-session nodeId check (no record to read),
 *  plus ask. */
export declare function bareQuestionTools(): Record<string, AgentTool<any>>;
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
export declare function createPracticeAgent(ctx: PracticeToolContext, opts?: AgentBuildOptions): any;
export type ProberAgent = ReturnType<typeof createProberAgent>;
export type TeacherAgent = ReturnType<typeof createTeacherAgent>;
export type PracticeAgent = ReturnType<typeof createPracticeAgent>;
export type TeachingAgent = ProberAgent | TeacherAgent | PracticeAgent;
//# sourceMappingURL=teacher-agent.d.ts.map