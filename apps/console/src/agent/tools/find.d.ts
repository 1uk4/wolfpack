import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
declare const findInput: Type.TObject<{
    pattern: Type.TString;
    path: Type.TOptional<Type.TString>;
    limit: Type.TOptional<Type.TInteger>;
}>;
export declare const findTool: AgentTool<typeof findInput>;
export {};
//# sourceMappingURL=find.d.ts.map