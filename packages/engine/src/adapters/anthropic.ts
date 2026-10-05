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

export interface AnthropicAdapterOptions {
  apiKey: string;
  baseUrl?: string;
}

export class AnthropicAdapter implements KnowledgeAdapter {
  private client: Anthropic;

  constructor(options: AnthropicAdapterOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
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
    const systemWithSchema = [
      options.system,
      "",
      "You MUST respond with valid JSON that matches this schema exactly.",
      "Do not include any text before or after the JSON.",
      "Do not wrap the JSON in markdown code fences.",
      "",
      "Schema (Zod description):",
      describeSchema(schema),
    ].join("\n");

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
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

      const response = await this.client.messages.create({
        model: options.model,
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0,
        system: systemWithSchema,
        messages,
      });

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

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract JSON from LLM response text. Handles:
 * - Pure JSON response
 * - JSON wrapped in markdown code fences
 * - JSON embedded in surrounding text
 */
function extractJSON(text: string): unknown {
  const trimmed = text.trim();

  // Try direct parse first
  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue to fallbacks
  }

  // Try stripping markdown code fences
  const fenced = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // Continue
    }
  }

  // Try finding first { ... } or [ ... ] block
  const braceStart = trimmed.indexOf("{");
  const bracketStart = trimmed.indexOf("[");
  const start =
    braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart)
      ? braceStart
      : bracketStart;

  if (start >= 0) {
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    for (let i = start; i < trimmed.length; i++) {
      if (trimmed[i] === open) depth++;
      else if (trimmed[i] === close) depth--;
      if (depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start, i + 1));
        } catch {
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Generate a human-readable description of a Zod schema for the LLM.
 * This tells the model what shape of JSON to produce.
 */
function describeSchema(schema: z.ZodType<unknown>): string {
  try {
    // Use Zod's internal shape description if available
    const desc = (schema as any)._def;
    if (desc?.typeName === "ZodObject" && desc.shape) {
      return JSON.stringify(
        describeShape(desc.shape()),
        null,
        2
      );
    }
  } catch {
    // Fallback
  }

  return "(structured JSON object — see system prompt for field details)";
}

function describeShape(shape: Record<string, any>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(shape)) {
    result[key] = describeZodType(value);
  }
  return result;
}

function describeZodType(zodType: any): string {
  const def = zodType?._def;
  if (!def) return "unknown";

  switch (def.typeName) {
    case "ZodString":
      return def.description ?? "string";
    case "ZodNumber":
      return def.description ?? "number";
    case "ZodBoolean":
      return def.description ?? "boolean";
    case "ZodEnum":
      return `enum: ${JSON.stringify(def.values)}`;
    case "ZodArray":
      return `array of ${describeZodType(def.type)}`;
    case "ZodOptional":
      return `(optional) ${describeZodType(def.innerType)}`;
    case "ZodNullable":
      return `(nullable) ${describeZodType(def.innerType)}`;
    case "ZodDefault":
      return `${describeZodType(def.innerType)} (default: ${JSON.stringify(def.defaultValue())})`;
    case "ZodObject":
      return JSON.stringify(describeShape(def.shape()));
    default:
      return def.description ?? def.typeName ?? "unknown";
  }
}
