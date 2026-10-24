/**
 * THE PRACTICE TOOLS (practice sessions, owner design 2026-10-04): the
 * practice agent's ENTIRE toolset — `problem` (pose: terminates the turn;
 * the commitment rides the call's arguments, hidden from the learner UI)
 * and `conclude` (end the problem: normal result, the turn continues so
 * the same reply can reveal + pose the next). The gating law (owner
 * ruling): an agent cannot pose while a problem is active and cannot
 * conclude with nothing active — activeProblemOf is the single fold both
 * gates read.
 *
 * Mechanics-only descriptions (the doctrine ruling, 2026-10-04): the tool
 * descriptions carry WHAT to pass and WHAT happens — the theory, the
 * commit-before-pose law, the hint ladder all live in the system prompt
 * (prompts/practice/10-doctrine.md).
 */
import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type JobToolContext } from "./jobs.ts";
import { type GraphToolContext } from "./graph.ts";
import type { LhMessage } from "../../core/native-messages.ts";
/** The record-reading context the gates need (the plan-tools idiom). */
export interface PracticeToolContext {
    chatId: string;
    chatStore: {
        getChat(id: string): {
            messages: LhMessage[];
            kind?: string;
        } | null;
    };
    /** The WHOLE-graph node list, read fresh per pose (owner round 9 — the
     *  mastery-trace contract): targets validate against every proposition,
     *  not just the session's picks, so pickless sessions and future
     *  graph-tools poses stay valid. Absent (tests) = no validation. */
    graphNodes?: () => ReadonlyArray<Pick<import("../../core/contracts/graph.ts").GraphNode, "id" | "name">>;
    /** THE RARELY-NEEDED SET (owner round 10, 2026-10-05): the map readers
     *  behind the SAME settings gate as the prober's (graphToolsEnabled at
     *  the composition root); the research + pdf jobs with the honest
     *  searchAvailable drop. Each absent (tests) = absent from the registry. */
    graph?: GraphToolContext;
    jobs?: JobToolContext;
}
/** TURN-SCOPED GATE STATE (the BKT incident, 2026-10-05): the gates used
 *  to read the STORED record — but the record freezes at the turn's
 *  write-ahead (persistTurn lands only at turn END), so a mid-turn
 *  conclude → pose pair could never see each other: every conclude
 *  succeeded against the stale record and every following pose died on
 *  "a problem is already active" until the model gave up ("the problem
 *  slot is stuck"). The gate seeds ONCE from the record at construction
 *  (one practiceTools per turn — chat-handler builds the agent per
 *  request, so there is no cross-turn leakage), and the executes flip
 *  this closure — the intra-turn truth the record cannot hold yet. */
export interface PracticeGate {
    problemActive: boolean;
}
/** Seed the turn's gate from the record (result-aware activeProblemOf —
 *  only a cleanly-posed problem counts). */
export declare function createPracticeGate(ctx: PracticeToolContext): PracticeGate;
export declare const problemInputObject: Type.TObject<{
    statement: Type.TString;
    mode: Type.TUnion<[Type.TLiteral<"recall">, Type.TLiteral<"discrimination">, Type.TLiteral<"composition">]>;
    target: Type.TOptional<Type.TArray<Type.TString>>;
    modelSolution: Type.TString;
}>;
export type ProblemInput = Static<typeof problemInputObject>;
export declare function problemTool(gate: PracticeGate, graphNodes?: PracticeToolContext["graphNodes"]): AgentTool<typeof problemInputObject>;
export declare const concludeInputObject: Type.TObject<{
    outcome: Type.TUnion<[Type.TLiteral<"solved">, Type.TLiteral<"solvedWithHints">, Type.TLiteral<"movedOn">, Type.TLiteral<"surrendered">, Type.TLiteral<"dismissed">]>;
    verdict: Type.TString;
    rung: Type.TUnion<[Type.TLiteral<"R0">, Type.TLiteral<"R1">, Type.TLiteral<"R2">, Type.TLiteral<"R3">, Type.TLiteral<"R4">, Type.TLiteral<"R5">, Type.TNull]>;
    missClass: Type.TUnion<[Type.TLiteral<"cue">, Type.TLiteral<"discrimination">, Type.TLiteral<"execution">, Type.TLiteral<"careless">, Type.TLiteral<"structural">, Type.TNull]>;
    retest: Type.TBoolean;
}>;
export type ConcludeInput = Static<typeof concludeInputObject>;
export declare function concludeTool(gate: PracticeGate): AgentTool<typeof concludeInputObject>;
/** The practice toolset (the practice agent's whole registry). */
export declare function practiceTools(ctx: PracticeToolContext): Record<string, AgentTool<any>>;
//# sourceMappingURL=practice.d.ts.map