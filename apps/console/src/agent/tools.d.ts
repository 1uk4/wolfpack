import type { AgentTool } from "@earendil-works/pi-agent-core";
import { askInputSchema, explainInputBase, explainInputObject, probeQuizInputSchema, quizInputObject } from "../core/question-core.ts";
import { type EnabledTools } from "../core/pending.ts";
import type { JobRecord } from "../core/contracts.ts";
import type { JobStore } from "../core/ports.ts";
import { jobTools, type DemoInput, type PdfInput, type ResearchInput, type VisualInput } from "./tools/jobs.ts";
import { type PlanToolContext } from "./tools/plan.ts";
import { type ProbeDoneContext } from "./tools/probe.ts";
import type { GraphStore } from "../core/ports.ts";
export { jobTools };
export type { ProbeDoneContext } from "./tools/probe.ts";
export declare const askUserQuestionTool: AgentTool<typeof askInputSchema>;
/** The canonical example body (owner-approved content, 2026-10-12): a
 *  compact applied question whose fields exercise the escaping hazards —
 *  braced commands (\frac, \cos), inline and display math, newlines —
 *  while doubling as an exemplar of good craft: uniform options, stable
 *  values, reasoning (explanation) committed before correctAnswer.
 *  JSON.stringify renders the wire text, so the escaping the model sees
 *  is by construction the correct one. Exported for the description pins. */
export declare const quizExampleBody: {
    question: string;
    options: {
        label: string;
        value: string;
    }[];
    explanation: string;
    correctAnswer: string;
};
/** The prober's multiple-choice quizzing tool — named `probe`, not
 *  `quiz` (owner, 2026-10-09): the probe and teach schemas differ
 *  (neither `type` nor `nodeId` exists while probing), and a shared name
 *  invited the model to carry its probe-phase call shape into teaching
 *  — the first teach quiz after plan_init dropped `nodeId` on exactly
 *  that habit (the tools_fails_2 incident). Distinct names make the
 *  phase boundary visible in the transcript itself: history written by
 *  `probe` never lies about what `quiz` requires. */
export declare const probeQuizTool: AgentTool<typeof probeQuizInputSchema>;
/** The teacher's free-recall variant (nodeId-validated, same seam as the
 *  teach quiz — phases/plan recognize BOTH tool names). */
export declare function teachExplainToolFor(ctx: Pick<PlanToolContext, "chatId" | "chatStore">): AgentTool<typeof explainInputObject>;
/** The prober's free-recall variant (no nodeId — same pattern as the
 *  probe quiz). */
/** The prober's free-recall variant — named `recall`, not `explain`
 *  (owner, 2026-10-09), for the same phase-boundary reason as `probe`:
 *  the teach explain adds `type` and `nodeId`; a shared name carried the
 *  probe call shape into teaching. Old probe-phase records keep the
 *  `explain` name and parse identically (the display seam accepts
 *  both). */
export declare const probeExplainTool: AgentTool<typeof explainInputBase>;
/** The prober's registry context: the probe's own needs (probe_done —
 *  ProbeDoneContext) PLUS the job-dispatch wiring, since the owner ruling
 *  (2026-09-20) puts research + pdf in the probe phase's registry too. */
export interface ProberToolContext extends ProbeDoneContext {
    /** Creates the job record (deduped by toolCallId). */
    jobStore: JobStore;
    /** Fire the background runner for a freshly created job. */
    spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
    /** Search availability — the research dispatch tool's honest-disable
     *  signal (same gate as the teacher's). Absent = available. */
    searchAvailable?: () => boolean;
    /** The prober's graph-map reader (wave 7): present = the two map tools
     *  (list_sessions / list_propositions) are registered. The composition
     *  root passes it only when graphToolsEnabled(effective) — the graph
     *  master switch AND the agent.graphTools toggle (settings-resolution).
     *  Absent = the gate is closed, no map tools (tests drive this seam). */
    graphStore?: GraphStore;
}
/** The prober's tool set: probe quiz (no nodeId) + ask + the learner-fs
 *  set + probe_done + the two phase-omnipresent job dispatch tools +
 *  (wave 7, gated) the graph-map reader. `enabled` is the resolved
 *  settings seam (core/pending.ts): any tool explicitly false is dropped
 *  from the registry. probe_done stays always-on regardless — it is how
 *  the phase ENDS; a prober that can never conclude is a lockout. */
export declare function createProberTools(ctx: ProberToolContext, enabled?: EnabledTools): Record<string, AgentTool<any>>;
/** Build the teach-side quiz tool for one request (exported for tests): the authoring contract
 *  + the per-session plan-nodeId validation (both run in execute — the
 *  grading contract is untouched). Reads the LIVE chat record, so rewrites
 *  mid-turn are honored, and with no tree yet every nodeId is rejected.
 *  nodeId is REQUIRED (owner ruling 2026-09-26): the untagged ad-hoc quiz is
 *  gone — off-map checks route through ask_user_question, and the teach
 *  seam (first tagged quiz) is structurally guaranteed. */
export declare function teachQuizToolFor(ctx: Pick<PlanToolContext, "chatId" | "chatStore">): AgentTool<typeof quizInputObject>;
export interface TeacherToolContext extends PlanToolContext {
    /** Job-tool wiring (sub-agent dispatch): the job store + the runner's
     *  spawn seam. The composition root injects both. */
    jobStore: JobStore;
    /** Fire the background runner for a freshly created job. The tool input
     *  rides along — the spawn fires mid-stream, before the tool part is
     *  persisted to the transcript (a transcript scan would race it). */
    spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
    /** Search availability (search port wave, 2026-09-20): the research
     *  dispatch tool's honest-disable signal — no live engine = the tool
     *  drops from this registry (JobToolContext.searchAvailable). */
    searchAvailable?: () => boolean;
}
/**
 * Per-request teacher tool registry: teach questions (validated nodeId) +
 * plan tools + job tools, all closing over the ctx.
 *
 * `enabled` is the resolved settings seam (core/pending.ts EnabledTools —
 * Platform's chat-handler wiring passes it through from settings). Today
 * only the sub-agent tools (research/demo/visual) are user-toggleable, but
 * the filtering is GENERIC: any name explicitly false is dropped, so
 * future toggleables (question-tool variants, …) need no change here.
 * Absent/undefined = enabled — tests and old records see today's set.
 */
/** The quizzing mechanics (owner 2026-09-27): `tools.explain === true` in
 *  the resolved settings ⇒ free-recall checks (explain armed, quiz dropped)
 *  — anything else ⇒ multiple choice, exactly today's set. Mechanics-
 *  managed, NOT individually toggleable: quiz/explain never pass through
 *  filterEnabledTools (the 2026-09-19 wedge ruling stands — a quiz-less
 *  prober collapses its assessment flow). */
export declare function quizMechanics(enabled?: EnabledTools): "choice" | "free";
export declare function createTeacherTools(ctx: TeacherToolContext, enabled?: EnabledTools): Record<string, AgentTool<any>>;
//# sourceMappingURL=tools.d.ts.map