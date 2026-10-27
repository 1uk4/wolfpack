/**
 * The spawn tools of a thread (`subagent`, `subagent_message`, `subagents_list`, `subagent_stop`) and the usage hook that
 * feeds a child's token count. Same names and wording as the terminal pi's subagent extension where they make sense.
 * The tools are offered to home and feature threads only: a child's conversation is configured without them (depth 1).
 */
import { GenerationTask, defineExtension as defineDurable, hook, type Extension } from "@earendil-works/pi-durable";
import { adaptToDurable } from "../adapters/durable.js";
import { Type, defineExtension, defineTool, type Tool, type ToolResult } from "../extension-api.js";
import type { SubagentManager, ToolOutcome } from "./subagents.js";
import { SPAWN_TOOLS } from "./subagents.js";

/** Late-bound handle to the manager: the tools are installed in the engine before the server (and its manager) exists. */
export class SubagentBridge {
  manager?: SubagentManager;
  require(): SubagentManager {
    if (!this.manager) throw new Error("subagents are not available on this wolf");
    return this.manager;
  }
}

const out = (o: ToolOutcome): ToolResult => ({ content: [{ type: "text", text: o.text }], ...(o.isError ? { isError: true } : {}) });

const SpawnParams = Type.Object({
  agent: Type.String({
    description:
      "Which agent to spawn (e.g. 'worker', 'scout', 'researcher'). This loads the agent's " +
      "fixed profile — its model, tool loadout, and system prompt. Must be one of the available agents.",
  }),
  task: Type.String({
    description:
      "The brief. The agent starts with zero context, so include: goal; relevant paths/context; " +
      "constraints (incl. files not to touch); done-when; exactly what to return.",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "Optional label for the subagent (its thread title and the handle for subagent_message / subagent_stop). Defaults to the agent name. " +
        "Has no effect on which agent runs — use `agent` for that.",
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Model tier override: main | smart | fast. Default: the agent's own tier (shown in subagents_list)." }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the sub-agent (absolute, or relative to the wolf's workspace). Default: the agent's own cwd, else the workspace.",
    }),
  ),
  isolation: Type.Optional(
    Type.String({
      description:
        'Where the sub-agent works: "worktree" (its own git worktree and branch) or "none" (the shared checkout). Default: the agent\'s own setting, else a worktree for an agent that can write (edit, write or bash) in a git directory, else none. ' +
        'A writer with "none" is refused while another writer is working in the same checkout. Outside git it is always "none".',
    }),
  ),
});

/** The spawn tools as a durable extension, plus the hook that counts a child's tokens. */
export function createSubagentExtension(bridge: SubagentBridge, config: { wolfDen: string; wolfName: string }): Extension[] {
  const tools: Tool[] = [
    defineTool({
      name: "subagent",
      description:
        "Delegate a task to a specialist sub-agent (see `subagents_list` for the roster and tiers). " +
        "Delegate anything that needs more than a couple of reads or commands, so your context stays small; spawn independent pieces in parallel. " +
        "Fire-and-forget: returns immediately; the result arrives automatically as a steer message. " +
        "Do not poll, sleep, tail logs or check status, and never fabricate or assume results: end your turn or do other independent work.",
      parameters: SpawnParams,
      execute: async (args, ctx) => out(await bridge.require().spawn(String(ctx.conversationId), args as never)),
    }),
    defineTool({
      name: "subagents_list",
      description:
        "List the subagent roster: each agent's tier and role (project-local agents override the wolf's, which override the package's), then your own sub-agents with their state.",
      parameters: Type.Object({}),
      execute: async (_args, ctx) => out(bridge.require().list(String(ctx.conversationId))),
    }),
    defineTool({
      name: "subagent_message",
      description:
        "Message a sub-agent by name (names persist after it finishes). Running: steers it. Finished, failed, stopped or waiting for your answer: " +
        "resumes it with your message. Fire-and-forget; the result arrives as a steer message. Don't poll.",
      parameters: Type.Object({
        name: Type.String({ description: "Exact name of the subagent. Steers it if it is still running; resumes it if it has finished." }),
        message: Type.String({ description: "The message to deliver: a follow-up instruction for a running subagent, the next task for a resumed one, or the answer to its question." }),
      }),
      execute: async (args, ctx) => {
        const a = args as { name: string; message: string };
        return out(await bridge.require().message(String(ctx.conversationId), a.name, a.message));
      },
    }),
    defineTool({
      name: "subagent_stop",
      description: "Cancel a running or waiting sub-agent by name. It stops (state stopped) and keeps its history; message it later to resume it.",
      parameters: Type.Object({
        name: Type.String({ description: "Exact name of the subagent to stop." }),
        abandon: Type.Optional(Type.Boolean({ description: "Also discard the sub-agent's worktree and branch (unmerged work is lost; it can no longer be resumed)." })),
      }),
      execute: async (args, ctx) => {
        const a = args as { name: string; abandon?: boolean };
        return out(await bridge.require().stopByName(String(ctx.conversationId), a.name, a.abandon === true));
      },
    }),
    defineTool({
      name: "subagent_merge",
      description:
        "Act on a worktree sub-agent's branch after its task shipped (the merge into the feature branch runs by itself on ship). " +
        'action "retry": merge now (after committing or stashing a dirty tree, or fixing a conflict by hand). "resolve": a worker subagent rebases the branch onto the feature branch and resolves the conflict, then it is merged again. ' +
        '"manual": the steps for the owner to resolve it by hand (the worktree and branch stay). "abandon": discard the worktree and branch.',
      parameters: Type.Object({
        name: Type.String({ description: "Exact name of the subagent whose branch it is." }),
        action: Type.String({ description: "retry | resolve | manual | abandon" }),
      }),
      execute: async (args, ctx) => {
        const a = args as { name: string; action: string };
        return out(await bridge.require().mergeByName(String(ctx.conversationId), a.name, a.action));
      },
    }),
  ];
  const toolsExt = adaptToDurable(defineExtension({ name: "wolfd-subagents", tools }), config);
  const usage = defineDurable({
    name: "wolfd-subagent-usage",
    hooks: [
      hook(GenerationTask, {
        afterResponse: (message, api) => {
          const u = (message as { usage?: { input?: number; output?: number } }).usage;
          const tokens = (u?.input ?? 0) + (u?.output ?? 0);
          if (tokens > 0) bridge.manager?.usage(String(api.conversationId), tokens);
        },
      }),
    ],
  });
  return [toolsExt, usage as Extension];
}

export { SPAWN_TOOLS };
