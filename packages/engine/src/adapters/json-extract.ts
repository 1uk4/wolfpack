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
 * - JSON wrapped in matched markdown code fences
 * - JSON with ONLY an opening fence (truncated response, closing fence lost)
 * - JSON with ONLY a trailing fence
 * - JSON embedded in surrounding text (brace-matching fallback)
 *
 * Robust to Claude 5-series behavior of wrapping outputs in ```json\n ... \n```
 * even when told not to, and to responses truncated mid-stream by maxTokens.
 */
export function extractJSON(text: string): unknown {
  const trimmed = text.trim();

  // 1) Pure JSON
  const direct = tryParse(trimmed);
  if (direct !== undefined) return direct;

  // 2) Matched fences: ```json ... ``` (greedy to allow fences inside strings)
  const matchedFence = trimmed.match(/```(?:json|JSON)?\s*\n?([\s\S]*)\n?```\s*$/);
  if (matchedFence) {
    const inner = tryParse(matchedFence[1].trim());
    if (inner !== undefined) return inner;
  }

  // 3) Unmatched fence: strip any leading ```json/``` and trailing ``` and retry.
  //    Handles both truncated-response and model-ignored-instruction cases.
  let stripped = trimmed
    .replace(/^```(?:json|JSON)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "");
  if (stripped !== trimmed) {
    const peeled = tryParse(stripped.trim());
    if (peeled !== undefined) return peeled;
  } else {
    stripped = trimmed;
  }

  // 4) Brace-matching fallback: find first { or [ and scan to matching close.
  //    String-aware so braces inside JSON strings don't throw the depth count.
  const braced = scanBalancedJson(stripped);
  if (braced !== undefined) return braced;

  return null;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/**
 * Scan for the first `{` or `[` and return the parsed JSON of the balanced
 * region ending at the matching close. String-aware: ignores `{`, `}`, `[`, `]`
 * that appear inside double-quoted strings (with backslash escapes). Returns
 * `undefined` if no parseable block is found.
 */
function scanBalancedJson(s: string): unknown | undefined {
  const braceStart = s.indexOf("{");
  const bracketStart = s.indexOf("[");
  const start =
    braceStart >= 0 && (bracketStart < 0 || braceStart < bracketStart)
      ? braceStart
      : bracketStart;
  if (start < 0) return undefined;

  const open = s[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return tryParse(s.slice(start, i + 1));
    }
  }
  return undefined;
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
