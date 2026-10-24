/**
 * runSubmitAgent — the shared single-submit agent seam (moved verbatim from
 * extraction.ts): one TypeBox-validated submit
 * call is the whole deliverable (a pi agent purely so the model can retry a
 * schema-invalid call). The submitted value is captured from the execute
 * seam, which only fires on a schema-valid call — the ??-fill (the old zod
 * defaults) applies at the capture.
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
export declare function healStringifiedArrays(raw: unknown): unknown;
export declare function runSubmitAgent<T>(opts: {
    role: ModelRole;
    toolName: string;
    toolDescription: string;
    parameters: TSchema;
    /** Weak-model tolerance: the old zod `.default()`s, applied to the
     *  schema-valid raw input at the submit seam. */
    fill: (input: any) => T;
    systemPrompt: string;
    prompt: string;
    engine: PiEngine | undefined;
    signal: AbortSignal | undefined;
    onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
    neverSubmitted: string;
    /** Extra tools beside the submit call (the auditor's graph-exploration
     *  set, 2026-09-27): a small agentic loop instead of a bare retry. */
    extraTools?: Record<string, AgentTool<any>>;
    /** Turn budget for the loop (default 4 = retry-only; the auditor runs
     *  an exploration loop instead — 16). */
    maxTurns?: number;
    /** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
    chatId?: string;
    /** Weak-model argument heal at pi's prepareArguments seam (runs BEFORE
     *  TypeBox validation — the sanctioned shim point). Identity by
     *  default; extraction wires healStringifiedArrays here. */
    prepareArguments?: (args: unknown) => unknown;
    /** Semantic validation at the submit seam: the value is schema-valid
     *  but may violate a PIPELINE law (coverage, echo-equality). Returning
     *  a problem string yields an isError result (invalidInputResult) →
     *  the model retries within maxTurns. null = accept. */
    validate?: (value: T) => string | null;
}): Promise<T>;
//# sourceMappingURL=submit-agent.d.ts.map