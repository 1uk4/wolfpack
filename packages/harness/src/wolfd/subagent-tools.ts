/**
 * The spawn tools of a thread (`subagent`, `subagent_message`, `subagents_list`, `subagent_stop`) and the usage hook that
 * feeds a child's token count. Same names and wording as the terminal pi's subagent extension where they make sense.
 * The tools are offered to home and feature threads only: a child's conversation is configured without them (depth 1).
 */
import { GenerationTask, defineExtension as defineDurable, hook, type Extension } from "@earendil-works/pi-durable";
import { adaptToDurable } from "../adapters/durable.js";
import { confirmCard } from "../engine/cards.js";
import { Type, defineExtension, defineTool, type Tool, type ToolContext, type ToolResult } from "../extension-api.js";
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
const firstLine = (m: { message: { content?: unknown } }): string => {
  const c = m.message.content;
  const block = Array.isArray(c) ? (c as { type?: string; text?: string }[]).find((x) => x?.type === "text" && typeof x.text === "string") : undefined;
  return (typeof c === "string" ? c : (block?.text ?? "")).split("\n")[0];
};

/**
 * The abandon gate, shared by subagent_merge (action abandon) and subagent_stop (abandon: true). A branch with no
 * unmerged commits is abandoned freely. Otherwise only the owner's structured yes passes (never the model's say-so):
 * a confirm card with a label unique to the branch and count, answered true and not spent (no later "Abandoned
 * <branch>" result), or the conflict card's own "Abandon branch" option for this branch, matched by label and value.
 * Skipping the card counts as no. Returns undefined to go ahead, else the result to return instead.
 */
async function abandonGate(bridge: SubagentBridge, tool: string, ctx: ToolContext, name: string): Promise<ToolResult | undefined> {
  const info = await bridge.require().abandonInfo(String(ctx.conversationId), name);
  if (!info) return undefined;
  if (info.refusal) return { content: [{ type: "text", text: info.refusal }], isError: true };
  if (info.unmerged === 0) return undefined;
  const text = (t: string, extra: Partial<ToolResult> = {}): ToolResult => ({ content: [{ type: "text", text: t }], ...extra });
  if (!ctx.conversation?.latestCard) return text(`Not abandoned: ${info.branch} has unmerged commits and nobody can confirm here.`, { isError: true });
  const n = info.unmerged === undefined ? "unknown unmerged commits" : `${info.unmerged} unmerged commit${info.unmerged === 1 ? "" : "s"}`;
  const label = `Abandon ${info.branch} (${n})?`;
  const found = await ctx.conversation.latestCard(tool, (c) => c.fields.length === 1 && c.fields[0].label === label);
  if (found?.status === "pending") return text(`The user was already asked whether to abandon ${info.branch}; their answer is pending. Do not ask again: your turn ends here.`, { endTurn: true });
  const yes = found?.status === "answered" && (found.answers?.confirm as { value?: unknown } | undefined)?.value === true;
  const spent = found?.laterResults.some((m) => firstLine(m).startsWith(`Abandoned ${info.branch}`)) ?? false;
  if (yes && !spent) return undefined;
  // The conflict card's own "Abandon branch" answer (this branch, matched by label and value).
  const conflict = await ctx.conversation.latestCard("ask_user_question", (c) => {
    const f = c.fields[0];
    return c.fields.length === 1 && f.kind === "single" && f.label.startsWith(`Merge conflict merging ${info.branch} into `) && f.options.some((o) => o.value === "abandon" && o.label === "Abandon branch");
  });
  if (conflict?.status === "answered") {
    const f = conflict.card.fields[0];
    if ((conflict.answers?.[f.id] as { value?: unknown } | undefined)?.value === "abandon") return undefined;
  }
  if (found?.status === "skipped" || found?.status === "answered") return text(`Not abandoned: the user said no. ${info.branch} stays. Do not ask again unless they bring it up.`);
  return text(`Asked the user to confirm abandoning ${info.branch}, which has ${n}. Your turn ends here. If they answer yes, call the same tool again to abandon it; if no, do not.`, {
    card: confirmCard({ tool, question: label, title: "Abandon branch?", description: `Its worktree and branch are deleted and the unmerged work is lost.`, confirmLabel: "Abandon", rejectLabel: "Keep" }),
  });
}

export function createSubagentExtension(bridge: SubagentBridge, config: { wolfDen: string; wolfName: string; onCardTool?: (name: string) => void }): Extension[] {
  const tools: Tool[] = [
    defineTool({
      name: "subagent",
      description:
        "Delegate a task to a specialist sub-agent (see `subagents_list` for the roster and tiers). " +
        "Delegate anything that needs more than a couple of reads or commands, so your context stays small; spawn independent pieces in parallel. " +
        "Fire-and-forget: returns immediately; the result arrives automatically as a steer message. " +
        "Do not poll, sleep, tail logs or check status, and never fabricate or assume results: end your turn or do other independent work.",
      parameters: SpawnParams,
      execute: async (args, ctx) => {
        const a = args as { agent: string; task: string; name?: string; model?: string; cwd?: string; isolation?: string };
        // (picked field by field: a model-supplied extra such as `resolves` never reaches the manager)
        return out(await bridge.require().spawn(String(ctx.conversationId), { agent: a.agent, task: a.task, ...(a.name !== undefined ? { name: a.name } : {}), ...(a.model !== undefined ? { model: a.model } : {}), ...(a.cwd !== undefined ? { cwd: a.cwd } : {}), ...(a.isolation !== undefined ? { isolation: a.isolation } : {}) }));
      },
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
      raisesCard: true,
      description:
        "Cancel a running or waiting sub-agent by name. It stops (state stopped) and keeps its history; message it later to resume it. " +
        "With abandon: true it also discards the sub-agent's worktree and branch (it can no longer be resumed); a branch with unmerged commits first asks the user to confirm with a card.",
      parameters: Type.Object({
        name: Type.String({ description: "Exact name of the subagent to stop." }),
        abandon: Type.Optional(Type.Boolean({ description: "Also discard the sub-agent's worktree and branch (unmerged commits need the user's confirmation card; it can no longer be resumed)." })),
      }),
      execute: async (args, ctx) => {
        const a = args as { name: string; abandon?: boolean };
        if (a.abandon !== true) return out(await bridge.require().stopByName(String(ctx.conversationId), a.name));
        const held = await abandonGate(bridge, "subagent_stop", ctx, a.name);
        if (held) return held;
        return out(await bridge.require().stopByName(String(ctx.conversationId), a.name, true, true));
      },
    }),
    defineTool({
      name: "subagent_merge",
      raisesCard: true,
      description:
        "Act on a worktree sub-agent's branch after its task shipped (the merge into the feature branch runs by itself on ship). " +
        'action "retry": merge now (after committing or stashing a dirty tree, or fixing a conflict by hand). "resolve": a worker subagent rebases the branch onto the feature branch and resolves the conflict, then it is merged again. ' +
        '"manual": the steps for the owner to resolve it by hand (the worktree and branch stay). "abandon": discard the worktree and branch (unmerged commits first ask the user to confirm with a card; the conflict card\'s Abandon branch answer counts).',
      parameters: Type.Object({
        name: Type.String({ description: "Exact name of the subagent whose branch it is." }),
        action: Type.String({ description: "retry | resolve | manual | abandon" }),
      }),
      execute: async (args, ctx) => {
        const a = args as { name: string; action: string };
        if (a.action !== "abandon") return out(await bridge.require().mergeByName(String(ctx.conversationId), a.name, a.action));
        const held = await abandonGate(bridge, "subagent_merge", ctx, a.name);
        if (held) return held;
        return out(await bridge.require().mergeByName(String(ctx.conversationId), a.name, a.action, true));
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
