/**
 * Provider factory map: pi provider id → factory. To add a provider (e.g. OpenRouter) add one entry here and name it
 * in a tier's `provider` in models.json / config.yaml; see README.md in this directory.
 */
import { anthropicFactory, anthropicLookupModels } from "./anthropic.js";
import { CLAUDE_BRIDGE_ID, claudeBridgeFactory, claudeBridgeLookupModels, claudeBridgeSdkSeams } from "./claude-bridge.js";
import { CLAUDE_STATELESS_ID, claudeStatelessFactory, claudeStatelessModels } from "./claude-stateless.js";
import type { ProviderFactory } from "./types.js";

export type { ProviderContext, ProviderFactory, ProviderHandle } from "./types.js";
export { guardProviderStreams } from "./guard.js";
export { lookupOnlyProvider } from "./lookup.js";

export const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  anthropic: anthropicFactory,
  [CLAUDE_BRIDGE_ID]: claudeBridgeFactory,
  [CLAUDE_STATELESS_ID]: claudeStatelessFactory,
};

/** Providers that run on the host's Agent SDK `query` (not bundleable): id → the seams to hand their factory. */
export const SDK_PROVIDER_SEAMS: Record<string, (query: unknown, env: NodeJS.ProcessEnv) => object> = {
  [CLAUDE_BRIDGE_ID]: claudeBridgeSdkSeams,
};

/** Providers that need CLAUDE_CODE_OAUTH_TOKEN (the Max subscription) in the environment to start. */
export const NEEDS_SUBSCRIPTION_TOKEN: ReadonlySet<string> = new Set([CLAUDE_BRIDGE_ID, CLAUDE_STATELESS_ID]);

/**
 * Optional per provider: its model list WITHOUT starting it. A den may hold stored refs to a provider this wolf's
 * tiers do not use (rollback, a VPS den); such providers are registered lookup-only from this list.
 */
export const LOOKUP_MODELS: Record<string, (ctx: { cwd: string; env: NodeJS.ProcessEnv }) => readonly any[]> = {
  anthropic: anthropicLookupModels,
  [CLAUDE_BRIDGE_ID]: claudeBridgeLookupModels,
  [CLAUDE_STATELESS_ID]: claudeStatelessModels,
};
