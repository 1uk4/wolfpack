/**
 * The engine — the central API surface.
 *
 * Create an engine with a config, get back typed methods for every
 * pipeline step. Each step uses the configured model (or its override)
 * and tracks usage automatically.
 *
 * Usage:
 *   const engine = createEngine({
 *     provider: "anthropic",
 *     apiKey: process.env.ANTHROPIC_API_KEY!,
 *     defaultModel: "claude-sonnet-4-20250514",
 *     steps: {
 *       classify: { model: "claude-haiku-4-5-20250507" },
 *     },
 *   });
 *
 *   const result = await engine.classify(observations);
 *   const assessment = await engine.assess(claim, relatedEntries);
 *   console.log(engine.usage.summarize());
 */
import type { z } from "zod";
import type { KnowledgeAdapter, UsageRecord } from "./adapter.js";
import { createAdapter } from "./adapters/index.js";
import {
  type EngineConfig,
  type PipelineStep,
  resolveModel,
} from "./config.js";
import { UsageTracker } from "./usage.js";

export interface Engine {
  /** The underlying adapter (for advanced use) */
  adapter: KnowledgeAdapter;
  /** Usage tracker — call .summarize() for totals */
  usage: UsageTracker;
  /** The config this engine was created with */
  config: EngineConfig;

  /**
   * Make a typed extraction call for a specific pipeline step.
   * Resolves model config from step overrides, validates with Zod,
   * retries on failure, and tracks usage.
   */
  call<T>(
    step: PipelineStep,
    schema: z.ZodType<T>,
    options: { system: string; prompt: string; signal?: AbortSignal }
  ): Promise<T>;
}

/**
 * Create an engine instance from config.
 */
export function createEngine(config: EngineConfig): Engine {
  const adapter = createAdapter(config);
  const usage = new UsageTracker();

  async function call<T>(
    step: PipelineStep,
    schema: z.ZodType<T>,
    options: { system: string; prompt: string; signal?: AbortSignal }
  ): Promise<T> {
    const modelConfig = resolveModel(config, step);

    const result = await adapter.extract(schema, {
      system: options.system,
      prompt: options.prompt,
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
      signal: options.signal,
    });

    // Tag the usage record with the step name
    const tagged: UsageRecord = { ...result.usage, step };
    usage.record(tagged);

    return result.data;
  }

  return { adapter, usage, config, call };
}
