import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore } from "../../core/ports.ts";
/** What the plan tools close over (the plan-tree half of the tool context). */
export interface PlanToolContext {
    chatId: string;
    /** The storage port plan tools persist through. */
    chatStore: ChatStore;
}
export declare function planTools(ctx: PlanToolContext): Record<string, AgentTool<any>>;
//# sourceMappingURL=plan.d.ts.map