import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { JobRecord } from "../../core/contracts.ts";
import type { JobStore } from "../../core/ports.ts";
/**
 * Async sub-agent job tools (vision §2.5; W2/W6 kinds + the pi-model
 * protocol). SERVER-EXECUTED: each call creates the job record, fires the
 * background runner (via the injected spawn seam — the agent layer never
 * imports one), and resolves IMMEDIATELY with a fire-and-forget ack. The
 * teacher's turn does NOT end at the call; the result arrives later as a
 * steer message that wakes the teacher in a new turn. See contracts.ts
 * "THE ASYNC PROTOCOL".
 */
/** What the job tools need at execute time (injected by the composition root). */
export interface JobToolContext {
    chatId: string;
    /** Creates the job record (deduped by toolCallId). */
    jobStore: JobStore;
    /** Fire the background runner for a fresh job — fire-and-forget. The
     *  input rides along because the spawn happens MID-STREAM, before
     *  onFinish persists the tool part — a transcript scan would race it. */
    spawn: (job: JobRecord, input: ResearchInput | DemoInput | VisualInput | PdfInput) => void;
    /** Search availability (search port wave, 2026-09-20): the honest
     *  disable signal for the research dispatch tool — no live engine
     *  means NO research tool in the registry (owner decision: registry-
     *  level drop, no doomed dispatch, no silent fallback). Absent =
     *  available (tests + any seam without search wiring). */
    searchAvailable?: () => boolean;
}
export declare const researchInputSchema: Type.TObject<{
    question: Type.TString;
    context: Type.TOptional<Type.TString>;
}>;
export declare const demoInputSchema: Type.TObject<{
    title: Type.TString;
    brief: Type.TString;
}>;
export declare const visualInputSchema: Type.TObject<{
    brief: Type.TString;
}>;
export declare const pdfInputSchema: Type.TObject<{
    path: Type.TString;
    question: Type.TString;
}>;
/**
 * Per-request job tool registry: each tool closes over the composition root's
 * context (chatId + jobStore + the spawn seam), so concurrent chats never
 * share state. chat-handler wires it each turn; tests wire their own.
 *
 * The research tool drops from the registry when ctx.searchAvailable reports
 * no live engine (2026-09-20) — the teacher never sees it, so a keyless
 * server can't dispatch doomed research jobs. Jobs ALREADY in flight when
 * a key disappears still run to their honest failure (runner backstop).
 */
export declare function jobTools(ctx: JobToolContext): Record<string, AgentTool<any>>;
export type ResearchInput = Static<typeof researchInputSchema>;
export type DemoInput = Static<typeof demoInputSchema>;
export type VisualInput = Static<typeof visualInputSchema>;
export type PdfInput = Static<typeof pdfInputSchema>;
//# sourceMappingURL=jobs.d.ts.map