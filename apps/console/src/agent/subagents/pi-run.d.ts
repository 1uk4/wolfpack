import { type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { type PiEngine } from "../models.ts";
import type { ModelRole } from "../../../config.ts";
/**
 * The shared sub-agent runner (docs/pi-engine-swap.md §6): one helper every
 * background agent (researcher, demo-builder, visual-maker, extractor,
 * auditor) runs on — a stateless pi Agent built per call, driven to
 * completion, with the seams the job runner and the money channel need.
 *
 * Error semantics mirror the old ToolLoopAgent.generate: provider/loop
 * failures THROW (pi encodes them in the stream; this helper surfaces
 * them), and an abort throws an AbortError so every existing
 * `signal.aborted` early-return keeps working unchanged.
 */
export interface SubagentRunOptions {
    /** The role whose engine (model + thinking level) this run uses. */
    role: ModelRole;
    /** Test seam: a scripted engine replaces the role's production one. */
    engine?: PiEngine;
    systemPrompt: string;
    /** Initial transcript (continuation semantics: ends user / toolResult). */
    messages?: AgentMessage[];
    /** Fresh-run prompt text (mutually exclusive with a continuation). */
    prompt?: string;
    /** Max model calls (the old stepCountIs safety net). */
    maxTurns: number;
    /** Abort mid-model-call (the real-kill semantics). */
    abortSignal?: AbortSignal;
    /** Money channel: one call per model request. */
    onUsage?: (usage: Usage) => void;
    /** Activity line per tool execution (job record progress). */
    onToolStart?: (toolName: string, args: unknown) => void;
    /** Per completed assistant message (extraction's step log). */
    onAssistantMessage?: (message: AssistantMessage, step: number) => void;
    /** Extra stop rule (extractor: stop after a clean submit). */
    shouldStop?: (message: AssistantMessage, toolResults: ToolResultMessage[]) => boolean;
    /** Debug: when set AND LH_PROVIDER_EVENTS=1, raw provider stream
     *  events append to data/debug/provider-events/<chatId>.jsonl (context
     *  "job:<role>"). Absent or env-off → no observer. */
    chatId?: string;
}
export interface SubagentRunResult {
    /** The messages this run added (assistant + tool results). */
    newMessages: AgentMessage[];
    /** The final assistant text (the deliverable). */
    text: string;
}
export declare function subagentEngine(role: ModelRole, override?: PiEngine): PiEngine;
export declare function runSubagent(tools: AgentTool<any, any>[], opts: SubagentRunOptions): Promise<SubagentRunResult>;
//# sourceMappingURL=pi-run.d.ts.map