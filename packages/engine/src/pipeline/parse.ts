/**
 * Parse — read and validate claim files and entry files from disk.
 * Pure code, no LLM.
 */
import { readFileSync, existsSync } from "node:fs";
import { ClaimSchema, type Claim } from "../schemas/claim.js";
import {
  EntryFrontmatterSchema,
  type EntryFrontmatter,
} from "../schemas/entry.js";

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/**
 * Parse YAML-ish frontmatter. Intentionally minimal — supports flat key: value
 * and array fields (both inline [a, b] and multi-line - item). No YAML dep.
 */
export function parseFrontmatter(
  raw: string
): { fields: Record<string, unknown>; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) return { fields: {}, body: raw };

  const fields: Record<string, unknown> = {};
  const lines = match[1].split("\n");
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of lines) {
    // Multi-line array item
    if (line.match(/^\s+-\s+/) && currentKey && currentArray) {
      currentArray.push(line.replace(/^\s+-\s+/, "").trim());
      continue;
    }

    // Flush pending array
    if (currentKey && currentArray) {
      fields[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Inline array: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      fields[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    // Empty value might start a multi-line array
    if (value === "") {
      currentKey = key;
      currentArray = [];
      continue;
    }

    fields[key] = value;
  }

  // Flush final pending array
  if (currentKey && currentArray) {
    fields[currentKey] = currentArray;
  }

  return { fields, body: match[2] };
}

/**
 * Parse a claim markdown file into a validated Claim object.
 */
export function parseClaim(filePath: string): Claim {
  const raw = readFileSync(filePath, "utf-8");
  const { fields, body } = parseFrontmatter(raw);

  // Extract body sections
  const sections = parseSections(body);

  return ClaimSchema.parse({
    from: fields.from,
    domain: fields.domain,
    origin: fields.origin ?? "intentional",
    submitted: fields.submitted,
    session: fields.session,
    title: extractTitle(body),
    claim: sections["the claim"] ?? sections["claim"] ?? "",
    evidence: sections["evidence"] ?? "",
    sources: fields.sources ?? extractSources(sections["sources"] ?? ""),
  });
}

/**
 * Parse entry frontmatter from a KB entry file.
 */
export function parseEntryFrontmatter(filePath: string): EntryFrontmatter {
  const raw = readFileSync(filePath, "utf-8");
  const { fields } = parseFrontmatter(raw);
  return EntryFrontmatterSchema.parse(fields);
}

/**
 * Read a full entry file — frontmatter + body.
 */
export function readEntryFile(
  filePath: string
): { frontmatter: Record<string, unknown>; body: string } | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const { fields, body } = parseFrontmatter(raw);
  return { frontmatter: fields, body };
}

// ── Internal helpers ────────────────────────────────────────────────────────

function extractTitle(body: string): string {
  const match = body.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim() ?? "Untitled";
}

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const re = /^##\s+(.+)$/gm;
  let lastKey: string | null = null;
  let lastEnd = 0;

  let match: RegExpExecArray | null;
  while ((match = re.exec(body)) !== null) {
    if (lastKey !== null) {
      sections[lastKey] = body.slice(lastEnd, match.index).trim();
    }
    lastKey = match[1].toLowerCase().trim();
    lastEnd = match.index + match[0].length;
  }

  if (lastKey !== null) {
    sections[lastKey] = body.slice(lastEnd).trim();
  }

  return sections;
}

function extractSources(sourcesText: string): string[] {
  return sourcesText
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}
