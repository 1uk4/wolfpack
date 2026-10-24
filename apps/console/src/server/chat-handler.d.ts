import { type AgentBuildOptions, type TeachingAgent } from "../agent/teacher-agent.ts";
import { type TurnInput } from "../core/input-events.ts";
/** The app's ONE extraction pipeline instance — both front doors share it:
 *  quiz-triggered session runs (turn-service) and notes imports
 *  (/api/graph/import) hit the same single-flight registry. */
export declare const extraction: import("../agent/subagents/extraction.ts").ExtractionPipeline;
/** The route-facing entry: parse {chatId, input} and run one turn. */
export declare function handleChatRequest(req: Request, buildAgent?: (opts: AgentBuildOptions & {
    teaching: boolean;
}) => TeachingAgent): Promise<Response>;
/**
 * The turn composition: one input event → native record appends → one
 * agent turn as a background object. Also the wake pipeline's entry
 * (TurnInput's steer kind appends the marker under the same claim).
 */
export declare function handleChatInput(chatId: string, input: TurnInput, buildAgent?: (opts: AgentBuildOptions & {
    teaching: boolean;
}) => TeachingAgent): Promise<Response>;
//# sourceMappingURL=chat-handler.d.ts.map