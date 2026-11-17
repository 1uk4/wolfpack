/**
 * claude-subscription: attaches the user's Claude subscription (Pro/Max) to Wolfpack as the provider `claude-subscription`.
 * It runs the user's own installed Claude Code (CLAUDE_CODE_PATH), so nothing heavy ships with the plug-in.
 * Template for your own provider plug-in: see README.md.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentSdkAdapter } from "@wolfpack/engine";
import { claudeStatelessModels, makeStatelessFactory, type PluginModule } from "@wolfpack/harness";

const ID = "claude-subscription";

/** `executable` is only needed when the user's `claude` is the npm JS launcher: CLAUDE_CODE_NODE names the node that runs it. */
const exec = (env: Record<string, string>) => ({
  pathToClaudeCodeExecutable: env.CLAUDE_CODE_PATH,
  ...(env.CLAUDE_CODE_NODE ? { executable: env.CLAUDE_CODE_NODE } : {}),
});

const plugin: PluginModule = {
  apiVersion: 1,
  createProvider: (ctx) => makeStatelessFactory(ID, exec(ctx.env))({ ...ctx, seams: { ...ctx.seams, [ID]: { ...(ctx.seams?.[ID] ?? {}), queryFn: query as never } } } as never),
  createEngineAdapter: ({ env }) => new ClaudeAgentSdkAdapter({ query: query as never, ...exec(env) }),
  models: (ctx) => claudeStatelessModels(ctx, ID),
};

export default plugin;
