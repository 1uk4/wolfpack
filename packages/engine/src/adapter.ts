/**
 * Knowledge adapter interface — the pluggable LLM layer.
 *
 * Every LLM call in the system goes through an adapter. The adapter takes
 * a prompt and a Zod schema, calls the LLM, and returns validated output.
 * If the output doesn't match the schema, the adapter retries with the
 * validation error (self-correction, like instructor-js).
 *
 * Implementations:
 *   - AnthropicAdapter (Anthropic API + Zod validation)
 *   - Future: OpenAI, local models, TypeSafe.ai, etc.
 */
import type { z } from "zod";

export interface ExtractOptions {
  /** System prompt for the LLM */
  system: string;
  /** User message / prompt content */
  prompt: string;
  /** Max retries on validation failure (default: 2) */
  maxRetries?: number;
  /** Model override (adapter has a default) */
  model?: string;
  /** Temperature override */
  temperature?: number;
}

export interface KnowledgeAdapter {
  /**
   * Extract structured data from an LLM call, validated against a Zod schema.
   * On validation failure, retries with the error message for self-correction.
   */
  extract<T>(schema: z.ZodType<T>, options: ExtractOptions): Promise<T>;
}
