import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ChatStore, GraphStore } from "../../core/ports.ts";
/**
 * THE PROBER'S GRAPH TOOLS (wave 7, owner-locked 2026-09-23): context
 * injection is dead — zero configuration beyond chat models. The prober
 * reads the learner's persistent knowledge map through two tools instead,
 * replacing the old injected block with on-demand eyes.
 *
 * Names + levels + dating ONLY — no statement text, no session contents
 * (owner ruling: the map's ORGANIZATION is the prober's business, its
 * prose is not). The data comes from Platform's pure core seams
 * (graphSessionIndex / graphSessionPropositions) over the same ports the
 * snapshot reads, so the prober and the learner's graph view can never
 * disagree.
 *
 * Registered on the prober ONLY when the settings gate opens
 * (graphToolsEnabled — the graph master switch AND the agent.graphTools
 * toggle); the composition root decides, the factory just receives the
 * store (absent = the gate is closed, no map tools — tests drive this).
 */
/** What the graph tools close over: the stores the session views read. */
export interface GraphToolContext {
    chatStore: ChatStore;
    graphStore: GraphStore;
}
export declare function proberGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>>;
export declare function auditorGraphTools(ctx: GraphToolContext): Record<string, AgentTool<any>>;
//# sourceMappingURL=graph.d.ts.map