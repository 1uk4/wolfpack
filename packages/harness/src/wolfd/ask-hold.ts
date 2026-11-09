/**
 * Hold-your-turn, enforced. While a paged `ask` has answered pages and is not complete, the thread is "held": every tool
 * call that could change state is refused with a tool error the agent sees. Allowed: `ask_revise`, the read-only tools
 * (READONLY_TOOL_NAMES: ls, grep, find and `guarded_bash`, whose commands the command guard keeps read-only; plus
 * `read`) and the read-only work queries. Everything else is refused by default (edit, write, bash, subagent spawn and
 * message, task writes, KB writes ...), so a newly added tool is held too until it is listed here.
 *
 * The hold covers THIS thread's own tool calls (a call with a parent, i.e. a subagent's, is not checked). Subagents
 * started before the questionnaire keep running; that is decided, not an oversight.
 *
 * The held state is not stored here: it is `CardTracker.holdOf()`, derived from the transcript, so it clears on its own
 * when the last page is submitted, the set is superseded or skipped, or the card is withdrawn, and survives a restart.
 */
import { ToolTask, defineExtension, hook, type Extension } from "@earendil-works/pi-durable";
import { READONLY_TOOL_NAMES } from "../engine/index.js";
import type { AskBridge } from "../extensions/ask.js";

/** Tools that stay available while a questionnaire is in progress (everything else is refused). render_mermaid / render_svg only write into the viz dir, so a revise can add a diagram. */
export const HELD_ALLOWED_TOOLS: ReadonlySet<string> = new Set([...READONLY_TOOL_NAMES, "read", "ask_revise", "render_mermaid", "render_svg", "task_query", "task_current", "task_features", "subagents_list"]);

export function holdRefusal(toolName: string, hold: { page: number; total: number }): string | undefined {
  if (HELD_ALLOWED_TOOLS.has(toolName)) return undefined;
  return `questionnaire in progress: page ${hold.page} of ${hold.total} pending; end your turn with text, or call ask_revise. ${toolName} is not allowed until the last page is submitted.`;
}

export function createAskHoldExtension(bridge: AskBridge): Extension {
  return defineExtension({
    name: "ask-hold",
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (call.parent) return undefined;
          const hold = bridge.host?.holdFor(String(api.conversationId));
          const block = hold && holdRefusal(call.name, hold);
          return block ? { block } : undefined;
        },
      }),
    ],
  });
}
