/**
 * Provider factory map: pi provider id → factory. To add a provider (e.g. OpenRouter) add one entry here and name it
 * in a tier's `provider` in models.json / config.yaml; see README.md in this directory.
 */
import { anthropicFactory, anthropicLookupModels } from "./anthropic.js";
import { CLAUDE_STATELESS_ID, LEGACY_CLAUDE_BRIDGE_ID, claudeStatelessFactory, claudeStatelessModels, claudeStatelessSdkSeams, legacyBridgeLookupModels } from "./claude-stateless.js";
import type { ProviderFactory } from "./types.js";

export type { ProviderContext, ProviderFactory, ProviderHandle } from "./types.js";
export { guardProviderStreams } from "./guard.js";
export { lookupOnlyProvider } from "./lookup.js";

/** The one provider registry: the built-ins below register into it, and so do plug-ins (plugins.ts). */
export const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {};

/** Register a provider factory under a pi provider id. A clash with a built-in or another plug-in is an error. */
export function registerProviderFactory(id: string, factory: ProviderFactory, lookupModels?: (typeof LOOKUP_MODELS)[string]): void {
  if (Object.hasOwn(PROVIDER_FACTORIES, id)) throw new Error(`model provider "${id}" is already registered`);
  PROVIDER_FACTORIES[id] = factory;
  if (lookupModels) LOOKUP_MODELS[id] = lookupModels;
}

export const hasProviderFactory = (id: string): boolean => Object.hasOwn(PROVIDER_FACTORIES, id);

/** Providers that run on the host's Agent SDK `query` (not bundleable): id → the seams to hand their factory. */
export const SDK_PROVIDER_SEAMS: Record<string, (query: unknown, env: NodeJS.ProcessEnv) => object> = {
  [CLAUDE_STATELESS_ID]: (query) => claudeStatelessSdkSeams(query),
};

/** Providers that need CLAUDE_CODE_OAUTH_TOKEN (the Max subscription) in the environment to start. */
export const NEEDS_SUBSCRIPTION_TOKEN: ReadonlySet<string> = new Set([CLAUDE_STATELESS_ID]);

/**
 * Optional per provider: its model list WITHOUT starting it. A den may hold stored refs to a provider this wolf's
 * tiers do not use (rollback, a VPS den); such providers are registered lookup-only from this list.
 */
export const LOOKUP_MODELS: Record<string, (ctx: { cwd: string; env: NodeJS.ProcessEnv }) => readonly any[]> = {
  anthropic: anthropicLookupModels,
  [LEGACY_CLAUDE_BRIDGE_ID]: legacyBridgeLookupModels,
  [CLAUDE_STATELESS_ID]: claudeStatelessModels,
};

registerProviderFactory("anthropic", anthropicFactory);
registerProviderFactory(CLAUDE_STATELESS_ID, claudeStatelessFactory);
