/**
 * Knowledge adapter interface — the pluggable LLM layer.
 *
 * Every LLM call in the system goes through an adapter. The adapter takes
 * a prompt and a Zod schema, calls the LLM, and returns validated output.
 * If validation fails, retries with the validation error (self-correction).
 *
 * Usage tracking is built in — every call records tokens and cost.
 */
import type { z } from "zod";

export interface ExtractOptions {
  /** System prompt for the LLM */
  system: string;
  /** User message / prompt content */
  prompt: string;
  /** Model to use (resolved from config) */
  model: string;
  /** Temperature (resolved from config) */
  temperature?: number;
  /** Max tokens for the response */
  maxTokens?: number;
  /** Max retries on validation failure (default: 2) */
  maxRetries?: number;
}

/**
 * Token usage from a single LLM call.
 */
export interface UsageRecord {
  step: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  timestamp: string;
}

/**
 * The adapter interface. One method: extract.
 * Implement this for each provider (Anthropic, OpenAI, etc.).
 *
 * To add a new provider:
 *   1. Create a new file in adapters/ (e.g. openai.ts)
 *   2. Implement KnowledgeAdapter
 *   3. Register it in adapters/index.ts
 * That's it. Nothing else changes.
 */
export interface KnowledgeAdapter {
  /**
   * Extract structured data from an LLM call, validated against a Zod schema.
   * On validation failure, retries with the error message for self-correction.
   * Records usage (tokens) for every call.
   */
  extract<T>(
    schema: z.ZodType<T>,
    options: ExtractOptions
  ): Promise<{ data: T; usage: UsageRecord }>;
}
