import type { Tool, Usage } from "@earendil-works/pi-ai";
import { type PiEngine } from "../models.ts";
import type { VisualResult } from "../../core/contracts.ts";
import { type HeadlessApi } from "./headless.ts";
/**
 * The visual-maker sub-agent (vision §2.5): authors ONE precise SVG from a
 * brief, renders it to a PNG with the same rasterizer the transcript
 * will use, LOOKS at the
 * result, and iterates until correct — a direct port of the vault POC's
 * svg-maker doctrine ("the one rule that matters: verify by looking").
 *
 * LOOP SHAPE (decided in the W6 brief): hand-rolled with generateText + a
 * messages array, because the loop must feed an IMAGE back to the model after
 * each render. write_svg / render_svg are declared WITHOUT execute — when the
 * model calls them generateText stops with the tool calls, and this loop
 * appends the tool results itself, followed by a user message containing the
 * rendered PNG as a file part ("Here is the current render"). ToolLoopAgent's
 * execute-tool plumbing can't express that image-in-the-loop shape cleanly.
 *
 * Doctrine enforcement in code: if the model tries to finish while the
 * current SVG has never been rendered (or changed since its last render), the
 * loop renders it anyway, shows the image, and asks the model to look before
 * finishing. Nothing is delivered without having been looked at.
 *
 * Failure semantics mirror the demo-builder: { svg: "", notes: "FAILED: …" }.
 */
export interface VisualMakerInput {
    brief: string;
}
export interface VisualMakerOptions {
    /** Test seam: scripted engine; production uses the visualMaker role. */
    engine?: PiEngine;
    headless?: HeadlessApi;
    /** Max model rounds (write/render cycles + final answer). Default 8. */
    maxIterations?: number;
    /** Live activity-line callback (updates the job record). */
    onActivity?: (line: string) => void;
    /** Kills the run mid-model-call (2026-09 real-kill abort semantics). */
    abortSignal?: AbortSignal;
    /** Money channel: one call per loop iteration (streamSimple), folded
     * into JobRecord.usage. */
    onUsage?: (usage: Usage) => void;
    /** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
    chatId?: string;
}
/** The wire declarations (pi-ai Tool, TypeBox parameters): this loop owns
 *  execution itself — write/edit dispatch inline below, render feeds the
 *  image-in-the-loop message — so the declarations carry no execute. */
export declare function createVisualTools(): Record<string, Tool>;
export declare function runVisualMaker(input: VisualMakerInput, opts?: VisualMakerOptions): Promise<VisualResult>;
//# sourceMappingURL=visual-maker.d.ts.map