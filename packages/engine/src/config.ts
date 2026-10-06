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
 *       consolidate: { model: "claude-sonnet-4-20250514" },    // needs judgment
 *       produce:     { model: "claude-sonnet-4-20250514" },    // needs writing quality
 *       contradict:  { model: "claude-haiku-4-5-20250507" },   // fast yes/no
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
  /** Memory: classify observations during the observer pass */
  classify?: ModelConfig;
  /** Memory: consolidate observations into topic files */
  consolidate?: ModelConfig;
  /** KB: produce a curated entry from a contribution (needs writing quality) */
  produce?: ModelConfig;
  /** KB: detect contradiction between a contribution and an existing entry (fast) */
  contradict?: ModelConfig;
  /** KB: classify an unroutable contribution into domain/type/subcategory (fast) */
  classifyEntry?: ModelConfig;
  /** KB: label a crystallized cluster with a canonical topic name (fast, deferrable) */
  labelTopic?: ModelConfig;
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
