/**
 * The ONLY file in the harness that knows about pi-claude-bridge (a grep test enforces it). Max-subscription
 * transport: the bridge runs the model through the Claude Agent SDK. `forget` closes the claude child parked for one
 * conversation; `dispose` kills every parked query. The orphan sweep (stale claude processes from a crashed run) is
 * the bridge's own, opted out via the `sweepOrphans` seam.
 */
import { createClaudeBridgeProvider, PROVIDER_ID, type ClaudeBridgeProvider, type ClaudeBridgeProviderOptions } from "pi-claude-bridge/core";
import { guardProviderStreams } from "./guard.js";
import type { ProviderFactory } from "./types.js";

export const CLAUDE_BRIDGE_ID: string = PROVIDER_ID;

/**
 * ENABLE_TOOL_SEARCH=false: the bridge runs claude with `tools: []`, which removes ToolSearch, yet Claude Code still
 * defers MCP tool schemas behind it. The model would see task_bind etc. by name only. Inline every schema.
 */
export const NO_TOOL_SEARCH = { ENABLE_TOOL_SEARCH: "false" } as const;

export interface ClaudeBridgeSeams {
  createProvider?: (opts: ClaudeBridgeProviderOptions) => ClaudeBridgeProvider;
  queryFn?: ClaudeBridgeProviderOptions["queryFn"];
  sweepOrphans?: boolean;
}

export const claudeBridgeFactory: ProviderFactory = (ctx) => {
  const seams = (ctx.seams?.[CLAUDE_BRIDGE_ID] ?? {}) as ClaudeBridgeSeams;
  // Env hygiene (stripping ANTHROPIC_API_KEY from the claude child) is done inside the bridge core.
  const provider = (seams.createProvider ?? createClaudeBridgeProvider)({
    cwd: ctx.cwd,
    env: { ...ctx.env, ...NO_TOOL_SEARCH },
    ...(seams.queryFn ? { queryFn: seams.queryFn } : {}),
    ...(seams.sweepOrphans === false ? { sweepOrphans: false } : {}),
  });
  guardProviderStreams(provider, { provider: CLAUDE_BRIDGE_ID });
  return { provider: provider as never, forget: (id) => void provider.release(id), dispose: () => provider.shutdown() };
};

/** Seams for a bridge that must run on the host's Agent SDK `query` (it cannot be bundled). */
export const claudeBridgeSdkSeams = (queryFn: unknown, env: NodeJS.ProcessEnv): ClaudeBridgeSeams => ({
  queryFn: queryFn as ClaudeBridgeSeams["queryFn"],
  ...(env.WOLF_HARNESS_SMOKE ? { sweepOrphans: false } : {}),
});
