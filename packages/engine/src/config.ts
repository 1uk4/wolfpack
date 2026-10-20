/**
 * Engine configuration — provider, models, and per-step overrides.
 *
 * The engine default model is the fallback. Individual pipeline steps
 * override it; in practice every step's model comes from the resolved model
 * table (see models.ts → `engineSteps(table)`), not from literals.
 *
 * Example:
 *   const { table } = loadModelTable();
 *   const config: EngineConfig = {
 *     provider: table.tiers.smart.provider,   // "claude-agent-sdk" | "anthropic"
 *     defaultModel: table.tiers.smart.model,  // e.g. "claude-sonnet-5-5"
 *     steps: engineSteps(table),              // each step on its tier's model
 *   };
 */
import type { EngineStep, ThinkingLevel } from "./models.js";

export interface ModelConfig {
  /** Model identifier (e.g. "claude-sonnet-5-5") */
  model: string;
  /** Thinking level (pi's names); unset = the model's default */
  thinking?: ThinkingLevel;
  /** Temperature override for this step */
  temperature?: number;
  /** Max tokens for this step's response */
  maxTokens?: number;
}

/** Per-step overrides, keyed by the engine steps in models.ts (ENGINE_STEPS). */
export type StepConfigs = Partial<Record<EngineStep, ModelConfig>>;

export interface EngineConfig {
  /** Provider name — determines which adapter is used */
  provider: string;
  /** API key for the provider. Not required by subscription-backed providers
   *  (e.g. claude-agent-sdk / claude-bridge), which authenticate via OAuth. */
  apiKey?: string;
  /** Base URL override (for proxies, local models, etc.) */
  baseUrl?: string;
  /** Absolute path to the `claude` executable, for the Claude Agent SDK
   *  provider. Omit to let the SDK resolve it from its own package. */
  pathToClaudeCodeExecutable?: string;
  /** Per-request timeout in ms (passed to the SDK client). Bounds how long a
   *  single call can hang before failing — without it a wedged produce can
   *  block on the SDK default (~10m) and stall a whole sweep. */
  requestTimeoutMs?: number;
  /** Default model — used when a step doesn't specify its own */
  defaultModel: string;
  /** Default temperature */
  defaultTemperature?: number;
  /** Default max tokens */
  defaultMaxTokens?: number;
  /** Per-step model overrides */
  steps?: StepConfigs;
}

export type PipelineStep = EngineStep;

/**
 * Resolve the model config for a specific pipeline step.
 * Falls back to engine defaults if the step has no override.
 */
export function resolveModel(
  config: EngineConfig,
  step: PipelineStep
): { model: string; thinking?: ThinkingLevel; temperature: number; maxTokens: number } {
  const stepConfig = config.steps?.[step];
  return {
    model: stepConfig?.model ?? config.defaultModel,
    thinking: stepConfig?.thinking,
    temperature: stepConfig?.temperature ?? config.defaultTemperature ?? 0,
    maxTokens: stepConfig?.maxTokens ?? config.defaultMaxTokens ?? 4096,
  };
}
