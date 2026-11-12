/**
 * Adapter registry — maps provider names to adapter constructors.
 *
 * To add a new provider:
 *   1. Create adapters/your-provider.ts implementing KnowledgeAdapter
 *   2. Add it to the registry below
 *   3. Done — users can now set provider: "your-provider" in their config
 */
import type { KnowledgeAdapter } from "../adapter.js";
import type { AdapterFactory } from "./registry.js";
import type { EngineConfig } from "../config.js";
import { AnthropicAdapter } from "./anthropic.js";
import { ClaudeAgentSdkAdapter } from "./claude-agent-sdk.js";

import { registerBuiltInAdapter, adapterIds, adapterFactory } from "./registry.js";

export { registerAdapter, type AdapterFactory } from "./registry.js";

const claudeAgentSdkFactory: AdapterFactory = (config) =>
  new ClaudeAgentSdkAdapter({
    pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
  });

const builtIns: Record<string, AdapterFactory> = {
  anthropic: (config) =>
    new AnthropicAdapter({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
    }),

  // Route through the local `claude` binary (Claude Agent SDK) — uses the
  // user's Claude subscription (MAX/Pro) instead of an API key. "claude-stateless"
  // is the pi provider name; "claude-bridge" is the legacy (retired) alias.
  "claude-agent-sdk": claudeAgentSdkFactory,
  "claude-stateless": claudeAgentSdkFactory,
  "claude-bridge": claudeAgentSdkFactory,

  // ── Add new providers here ──────────────────────────────────────────────
  // openai: (config) => new OpenAIAdapter({ apiKey: config.apiKey }),
  // local: (config) => new LocalAdapter({ baseUrl: config.baseUrl }),
};

// Built-ins and plug-ins (registerAdapter) share one registry.
for (const [id, factory] of Object.entries(builtIns)) registerBuiltInAdapter(id, factory);

/**
 * Create an adapter from an engine config.
 * Throws if the provider is not registered.
 */
export function createAdapter(config: EngineConfig): KnowledgeAdapter {
  const factory = adapterFactory(config.provider);
  if (!factory) {
    const available = adapterIds().join(", ");
    throw new Error(
      `Unknown provider "${config.provider}". Available: ${available}. ` +
        `To add a new provider, create an adapter in packages/engine/src/adapters/ ` +
        `and register it in the registry.`
    );
  }
  return factory(config);
}
