import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
declare const lsInput: Type.TObject<{
    path: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TInteger>;
}>;
export declare const lsTool: AgentTool<typeof lsInput>;
export {};
//# sourceMappingURL=ls.d.ts.map