/**
 * @wolfpack/engine — the knowledge management engine.
 *
 * Schemas define every LLM call's contract.
 * Pipeline provides the pure-code functions.
 * Engine is the main API surface.
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
} from "./config.js";

// Schemas — the contracts
export * from "./schemas/index.js";

// Adapter — the LLM interface
export type { KnowledgeAdapter, ExtractOptions, UsageRecord } from "./adapter.js";

// Adapters — provider implementations
export { AnthropicAdapter } from "./adapters/anthropic.js";
export { createAdapter } from "./adapters/index.js";

// Usage tracking
export { UsageTracker, type UsageSummary } from "./usage.js";

// Pipeline — parse, search, commit, index
export * from "./pipeline/index.js";
