/**
 * Shared JSON-extraction + schema-description helpers.
 *
 * Both the Anthropic API adapter and the Claude Agent SDK adapter prompt the
 * model for raw JSON and then parse/validate it. These helpers are the common
 * part: pulling a JSON value out of a (possibly fenced / chatty) response, and
 * describing a Zod schema so the model knows what shape to produce.
 */
import type { z } from "zod";

/**
 * Extract JSON from LLM response text. Handles:
 * - Pure JSON response
 * - JSON wrapped in markdown code fences
 * - JSON embedded in surrounding text
 */
export function extractJSON(text: string): unknown {
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
export function describeSchema(schema: z.ZodType<unknown>): string {
  try {
    // Use Zod's internal shape description if available
    const desc = (schema as any)._def;
    if (desc?.typeName === "ZodObject" && desc.shape) {
      return JSON.stringify(describeShape(desc.shape()), null, 2);
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

/**
 * Build the system prompt that instructs the model to emit only schema-valid
 * JSON. Shared so every adapter frames the extraction identically.
 */
export function buildSystemWithSchema(
  system: string,
  schema: z.ZodType<unknown>
): string {
  return [
    system,
    "",
    "You MUST respond with valid JSON that matches this schema exactly.",
    "Do not include any text before or after the JSON.",
    "Do not wrap the JSON in markdown code fences.",
    "",
    "Schema (Zod description):",
    describeSchema(schema),
  ].join("\n");
}
