import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { SearchHit as WebSearchResult, SearchProvider } from "../../core/search.ts";
export type { WebSearchResult };
export declare function createWebTools(search: () => SearchProvider | null): Record<string, AgentTool<any>>;
/** The provider-less backstop (tests pin the shape with it; the runner
 *  always injects the real seam — an absent seam reads as unavailable,
 *  never a crash and never a silent alternative engine). */
export declare const webTools: Record<string, AgentTool<any>>;
//# sourceMappingURL=web.d.ts.map