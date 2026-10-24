import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore } from "../../core/ports.ts";
import { type SteerMessage } from "../../core/contracts.ts";
/** What the probe_done tool closes over. */
export interface ProbeDoneContext {
    chatId: string;
    /** The storage port (open-question + already-concluded checks). */
    chatStore: ChatStore;
    /** Queue the handoff steer (the wake pipeline — src/server/jobs.ts).
     *  Injected so this module never imports the server seam. */
    deliver: (steer: SteerMessage) => void;
}
/**
 * probe_done — the probe→planning seam (docs/probe-teach-split.md §2).
 *
 * SERVER-SIDE. The prober concludes the probe by authoring the learner
 * assessment (the tool INPUT — it streams to the learner live and is
 * durable in the transcript as the tool part itself). Three outcomes:
 *
 *   ok:false + error — a question is still open ("resolve it first"), or
 *     the probe is already concluded. The refusal returns to the prober as
 *     a tool result; it fixes course and retries (the return-to-agent
 *     doctrine, same as nodeId validation).
 *   ok:true — the assessment is recorded, and the HANDOFF is queued: a
 *     steer through the wake pipeline that fires the teacher's first turn
 *     (plan authoring) the moment the prober's turn ends. Auto-wake is the
 *     user-decided trigger — the learner experiences assessment → plan as
 *     one continuous flow. CONTEXT-SLIM (owner, context diet 2026-10-09):
 *     the call's arguments already carry the assessment (durable, streamed
 *     live), so the agent sees the fixed PROBE_DONE_ACK_TEXT — never an
 *     echo. details = {ok:true} only.
 *
 * The first probe_done in the transcript is also the construction seam:
 * from that message on, every request builds the TEACHER agent.
 */
export declare function probeDoneTool(ctx: ProbeDoneContext): Record<string, AgentTool<any>>;
//# sourceMappingURL=probe.d.ts.map