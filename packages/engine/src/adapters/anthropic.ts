/**
 * Anthropic adapter — uses the Anthropic SDK to make structured extraction calls.
 *
 * Strategy:
 *   1. Send prompt with instructions to return JSON matching the schema
 *   2. Parse the JSON from the response
 *   3. Validate against the Zod schema
 *   4. On validation failure, retry with the error message for self-correction
 *   5. Track token usage on every call
 */
import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type {
  KnowledgeAdapter,
  ExtractOptions,
  UsageRecord,
} from "../adapter.js";
import { buildSystemWithSchema, extractJSON } from "./json-extract.js";

export interface AnthropicAdapterOptions {
  /** Omit to fall back to the SDK's ANTHROPIC_API_KEY env lookup. */
  apiKey?: string;
  baseUrl?: string;
  /** Per-request timeout in ms. Bounds a single hanging call. */
  timeoutMs?: number;
}

export class AnthropicAdapter implements KnowledgeAdapter {
  private client: Anthropic;

  constructor(options: AnthropicAdapterOptions) {
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
    });
  }

  async extract<T>(
    schema: z.ZodType<T>,
    options: ExtractOptions
  ): Promise<{ data: T; usage: UsageRecord }> {
    const maxRetries = options.maxRetries ?? 2;
    let lastError: Error | null = null;
    let totalInput = 0;
    let totalOutput = 0;

    // Build the system prompt with schema instructions
    const systemWithSchema = buildSystemWithSchema(options.system, schema);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      options.signal?.throwIfAborted();
      const messages: Anthropic.MessageParam[] = [];

      if (attempt === 0) {
        messages.push({ role: "user", content: options.prompt });
      } else {
        // Self-correction: include the previous attempt and error
        messages.push({ role: "user", content: options.prompt });
        messages.push({
          role: "assistant",
          content: lastError?.message ?? "Invalid output",
        });
        messages.push({
          role: "user",
          content: [
            "Your previous response did not match the required schema.",
            "Validation error:",
            lastError?.message ?? "Unknown error",
            "",
            "Please try again. Respond with valid JSON only.",
          ].join("\n"),
        });
      }

      const response = await this.client.messages.create(
        {
          model: options.model,
          max_tokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0,
          system: systemWithSchema,
          messages,
        },
        options.signal ? { signal: options.signal } : undefined
      );

      // Track usage
      totalInput += response.usage.input_tokens;
      totalOutput += response.usage.output_tokens;

      // Extract text content
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      // Parse JSON from response
      const json = extractJSON(text);
      if (json === null) {
        lastError = new Error(
          `Could not extract JSON from response: ${text.slice(0, 200)}`
        );
        continue;
      }

      // Validate against schema
      const result = schema.safeParse(json);
      if (result.success) {
        return {
          data: result.data,
          usage: {
            step: "",  // Filled in by the caller
            model: options.model,
            inputTokens: totalInput,
            outputTokens: totalOutput,
            timestamp: new Date().toISOString(),
          },
        };
      }

      // Validation failed — build error message for retry
      lastError = new Error(
        result.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      );
    }

    throw new Error(
      `Failed to extract valid output after ${maxRetries + 1} attempts. ` +
        `Last error: ${lastError?.message}`
    );
  }
}

