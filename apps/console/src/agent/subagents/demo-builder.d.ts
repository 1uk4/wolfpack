import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import type { DemoResult } from "../../core/contracts.ts";
import { type DemoRunResult, type HeadlessApi } from "./headless.ts";
/**
 * The demo-builder sub-agent (vision §2 interactive demos + §2.5 "sub-agents
 * verify; they never one-shot"): given a brief it writes a self-contained
 * single-file HTML/JS demo, TESTS IT HEADLESSLY (run_demo), and iterates
 * fix → re-run until clean — before anything reaches the lesson.
 *
 * Shape: a ToolLoopAgent with two executable tools (write_demo / run_demo) —
 * the engine is injectable (tests use a scripted faux engine) and the headless
 * API is injectable (tests use a fake; production uses the app's own
 * Chromium browser service, system Chrome as fallback).
 *
 * Failure semantics (decided in the W6 brief): `tested: true` means "the
 * verify loop ran"; on failure the result is { title, html: "", tested: true,
 * notes: "FAILED: <reason>" } — the card renders the failure note, no iframe.
 * The job wrapper treats html === "" as failure and marks the job error.
 */
export interface DemoBuilderInput {
    title: string;
    brief: string;
}
export interface DemoBuilderOptions {
    /** Test seam: scripted engine; production uses the demoBuilder role. */
    engine?: PiEngine;
    headless?: HeadlessApi;
    /** Max agent steps (each write/run/fix is one step). Default 24 ≈ 6 cycles. */
    maxSteps?: number;
    /** Live activity-line callback (updates the job record). */
    onActivity?: (line: string) => void;
    /** Kills the run mid-model-call (2026-09 real-kill abort semantics). */
    abortSignal?: AbortSignal;
    /** Money channel: one call per agent step, folded into JobRecord.usage. */
    onUsage?: (usage: Usage) => void;
    /** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
    chatId?: string;
}
interface BuilderState {
    html: string | null;
    /** The html that the last run_demo tested (null = never tested). */
    testedHtml: string | null;
    lastResult: DemoRunResult | null;
}
export declare function createDemoBuilderTools(state: BuilderState, headless: HeadlessApi, onActivity?: (line: string) => void): Record<string, AgentTool<any>>;
export declare function runDemoBuilder(input: DemoBuilderInput, opts?: DemoBuilderOptions): Promise<DemoResult>;
export {};
//# sourceMappingURL=demo-builder.d.ts.map