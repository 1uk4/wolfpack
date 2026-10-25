/**
 * @wolfpack/engine — the knowledge management engine.
 *
 * Schemas define every LLM call's contract.
 * Pipeline provides the pure-code functions.
 * Engine is the main API surface.
 * Prompts contains all system prompts used throughout the wolfpack pipeline.
 */

// Engine — the main entry point
export { createEngine, type Engine } from "./engine.js";

// Config
export {
  type EngineConfig,
  type ModelConfig,
  type StepConfigs,
  type PipelineStep,
  resolveModel,
  DEFAULT_MAX_TOKENS,
} from "./config.js";

// Models — tiers, the resolver and the one loader every runtime calls
export * from "./models.js";

// wolf.yaml v2 — schema, loader, discovery, tier resolution
export * from "./wolfconfig/index.js";

// Prompts — central registry of all system prompts
export * from "./prompts.js";

// Config — the editable control surface (vocabularies + numeric knobs)
export * from "./config/index.js";

// Adapter — the LLM interface
export type { KnowledgeAdapter, ExtractOptions, UsageRecord } from "./adapter.js";

// Adapters — provider implementations
export { AnthropicAdapter } from "./adapters/anthropic.js";
export { LlmInfraError, OutputTruncatedError } from "./adapters/errors.js";
export { createAdapter } from "./adapters/index.js";

// Usage tracking
export { UsageTracker, type UsageSummary } from "./usage.js";
export * from "./usage-log.js";

// Pipeline — parse, search, commit, index
export * from "./pipeline/index.js";
