/**
 * Engine configuration — provider, models, and per-step overrides.
 *
 * The engine default model is the fallback. Individual pipeline steps
 * can override to use cheaper/faster or stronger models as needed.
 *
 * Example:
 *   const config: EngineConfig = {
 *     provider: "anthropic",
 *     apiKey: process.env.ANTHROPIC_API_KEY!,
 *     defaultModel: "claude-sonnet-4-20250514",
 *     steps: {
 *       classify:    { model: "claude-haiku-4-5-20250507" },   // cheap + fast
 *       assess:      { model: "claude-sonnet-4-20250514" },    // needs judgment
 *       produce:     { model: "claude-sonnet-4-20250514" },    // needs writing quality
 *       link:        { model: "claude-haiku-4-5-20250507" },   // structured, simple
 *       consolidate: { model: "claude-sonnet-4-20250514" },    // needs judgment
 *       claimCheck:  { model: "claude-haiku-4-5-20250507" },   // yes/no decision
 *     },
 *   };
 */

export interface ModelConfig {
  /** Model identifier (e.g. "claude-sonnet-4-20250514", "gpt-4o") */
  model: string;
  /** Temperature override for this step */
  temperature?: number;
  /** Max tokens for this step's response */
  maxTokens?: number;
}

export interface StepConfigs {
  /** Classify observations (knowledge vs work item) */
  classify?: ModelConfig;
  /** Assess claims (create/merge/supersede/reject) */
  assess?: ModelConfig;
  /** Produce curated entries from claims */
  produce?: ModelConfig;
  /** Detect links between entries */
  link?: ModelConfig;
  /** Consolidate observations into topic files */
  consolidate?: ModelConfig;
  /** Evaluate whether something is claim-worthy */
  claimCheck?: ModelConfig;
}

export interface EngineConfig {
  /** Provider name — determines which adapter is used */
  provider: string;
  /** API key for the provider */
  apiKey: string;
  /** Base URL override (for proxies, local models, etc.) */
  baseUrl?: string;
  /** Default model — used when a step doesn't specify its own */
  defaultModel: string;
  /** Default temperature */
  defaultTemperature?: number;
  /** Default max tokens */
  defaultMaxTokens?: number;
  /** Per-step model overrides */
  steps?: StepConfigs;
}

export type PipelineStep = keyof StepConfigs;

/**
 * Resolve the model config for a specific pipeline step.
 * Falls back to engine defaults if the step has no override.
 */
export function resolveModel(
  config: EngineConfig,
  step: PipelineStep
): { model: string; temperature: number; maxTokens: number } {
  const stepConfig = config.steps?.[step];
  return {
    model: stepConfig?.model ?? config.defaultModel,
    temperature: stepConfig?.temperature ?? config.defaultTemperature ?? 0,
    maxTokens: stepConfig?.maxTokens ?? config.defaultMaxTokens ?? 4096,
  };
}
