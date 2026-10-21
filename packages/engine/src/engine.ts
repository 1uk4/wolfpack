/**
 * The engine — the central API surface.
 *
 * Create an engine with a config, get back typed methods for every
 * pipeline step. Each step uses the configured model (or its override)
 * and tracks usage automatically.
 *
 * Usage:
 *   const { table } = loadModelTable();
 *   const engine = createEngine({
 *     provider: table.tiers.smart.provider,
 *     defaultModel: table.tiers.smart.model,
 *     steps: engineSteps(table),
 *   });
 *
 *   const result = await engine.call("classify", Schema, { system, prompt });
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
import * as path from "node:path";
import { appendUsageEvent, billingFor, type UsageEvent } from "./usage-log.js";

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
  const log = usageLogTarget(config);

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
      thinking: modelConfig.thinking,
      temperature: modelConfig.temperature,
      maxTokens: modelConfig.maxTokens,
      signal: options.signal,
    });

    // Tag the usage record with the step name
    const tagged: UsageRecord = { ...result.usage, step };
    usage.record(tagged);
    if (log) appendUsageEvent(log.den, usageEvent(tagged, config.provider, log.wolf));

    return result.data;
  }

  return { adapter, usage, config, call };
}

/** The den to log usage to: explicit config, else WOLF_DEN / WOLF_NAME, else none. */
function usageLogTarget(config: EngineConfig): { den: string; wolf: string } | undefined {
  if (config.usageLog === false) return undefined;
  if (config.usageLog) return config.usageLog;
  const den = process.env.WOLF_DEN;
  if (!den) return undefined;
  return { den, wolf: process.env.WOLF_NAME || path.basename(path.dirname(den)) };
}

function usageEvent(r: UsageRecord, provider: string, wolf: string): UsageEvent {
  const billing = billingFor(provider);
  const reported = typeof r.costUsd === "number" && r.costUsd > 0;
  return {
    ts: r.timestamp,
    wolf,
    source: "engine",
    use: `step:${r.step}`,
    provider,
    billing,
    model: r.model,
    input: r.inputTokens,
    output: r.outputTokens,
    cacheRead: r.cacheReadTokens ?? 0,
    cacheWrite: r.cacheWriteTokens ?? 0,
    ...(reported ? { costUsd: r.costUsd } : {}),
    // The Agent SDK's cost is the API equivalent; on the Max plan it's notional.
    costSource: reported ? (billing === "subscription" ? "notional" : "reported") : "unknown",
  };
}

