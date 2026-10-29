/**
 * Provider factory map: pi provider id → factory. To add a provider (e.g. OpenRouter) add one entry here and name it
 * in a tier's `provider` in models.json / config.yaml; see README.md in this directory.
 */
import { anthropicFactory } from "./anthropic.js";
import { CLAUDE_BRIDGE_ID, claudeBridgeFactory, claudeBridgeSdkSeams } from "./claude-bridge.js";
import type { ProviderFactory } from "./types.js";

export type { ProviderContext, ProviderFactory, ProviderHandle } from "./types.js";
export { guardProviderStreams } from "./guard.js";

export const PROVIDER_FACTORIES: Record<string, ProviderFactory> = {
  anthropic: anthropicFactory,
  [CLAUDE_BRIDGE_ID]: claudeBridgeFactory,
};

/** Providers that run on the host's Agent SDK `query` (not bundleable): id → the seams to hand their factory. */
export const SDK_PROVIDER_SEAMS: Record<string, (query: unknown, env: NodeJS.ProcessEnv) => object> = {
  [CLAUDE_BRIDGE_ID]: claudeBridgeSdkSeams,
};
