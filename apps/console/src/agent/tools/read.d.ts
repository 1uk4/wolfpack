import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
declare const readInput: Type.TObject<{
    path: Type.TString;
    offset: Type.TOptional<Type.TInteger>;
    limit: Type.TOptional<Type.TInteger>;
}>;
/**
 * The read tool, shared verbatim by the prober and the teacher. Sources v1
 * (2026-09-19): the description is pi-verbatim (user: copy tool usage
 * guidance exactly) — the teaching doctrine moved to the shared prompt
 * fragment (prompts/shared/). Relative paths resolve against the
 * learner's home (fs-shared.ts), the harness's anchor.
 */
export declare const readTool: AgentTool<typeof readInput>;
export {};
//# sourceMappingURL=read.d.ts.map