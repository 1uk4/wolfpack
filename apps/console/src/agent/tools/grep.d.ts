import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
declare const grepInput: Type.TObject<{
    pattern: Type.TString;
    path: Type.TOptional<Type.TString>;
    glob: Type.TOptional<Type.TString>;
    ignoreCase: Type.TOptional<Type.TBoolean>;
    literal: Type.TOptional<Type.TBoolean>;
    context: Type.TOptional<Type.TInteger>;
    limit: Type.TOptional<Type.TInteger>;
}>;
export declare const grepTool: AgentTool<typeof grepInput>;
export {};
//# sourceMappingURL=grep.d.ts.map