/**
 * Adapter registry — maps provider names to adapter constructors.
 *
 * To add a new provider:
 *   1. Create adapters/your-provider.ts implementing KnowledgeAdapter
 *   2. Add it to the registry below
 *   3. Done — users can now set provider: "your-provider" in their config
 */
import type { KnowledgeAdapter } from "../adapter.js";
import type { EngineConfig } from "../config.js";
import { AnthropicAdapter } from "./anthropic.js";
import { ClaudeAgentSdkAdapter } from "./claude-agent-sdk.js";

type AdapterFactory = (config: EngineConfig) => KnowledgeAdapter;

const claudeAgentSdkFactory: AdapterFactory = (config) =>
  new ClaudeAgentSdkAdapter({
    pathToClaudeCodeExecutable: config.pathToClaudeCodeExecutable,
  });

const registry: Record<string, AdapterFactory> = {
  anthropic: (config) =>
    new AnthropicAdapter({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
    }),

  // Route through the local `claude` binary (Claude Agent SDK) — uses the
  // user's Claude subscription (MAX/Pro) instead of an API key. "claude-bridge"
  // is an alias matching the pi provider name.
  "claude-agent-sdk": claudeAgentSdkFactory,
  "claude-bridge": claudeAgentSdkFactory,

  // ── Add new providers here ──────────────────────────────────────────────
  // openai: (config) => new OpenAIAdapter({ apiKey: config.apiKey }),
  // local: (config) => new LocalAdapter({ baseUrl: config.baseUrl }),
};

/**
 * Create an adapter from an engine config.
 * Throws if the provider is not registered.
 */
export function createAdapter(config: EngineConfig): KnowledgeAdapter {
  const factory = registry[config.provider];
  if (!factory) {
    const available = Object.keys(registry).join(", ");
    throw new Error(
      `Unknown provider "${config.provider}". Available: ${available}. ` +
        `To add a new provider, create an adapter in packages/engine/src/adapters/ ` +
        `and register it in the registry.`
    );
  }
  return factory(config);
}
