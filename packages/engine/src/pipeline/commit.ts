/**
 * Commit — write curated entries to disk. Pure code, no LLM.
 * All writes are atomic (temp + rename).
 */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Entry, EntryFrontmatter } from "../schemas/entry.js";

/** Atomic write — temp file + rename. Never leaves a half-written file. */
export function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

/** Render an Entry to markdown with YAML frontmatter. */
export function renderEntry(entry: Entry): string {
  const fm = renderFrontmatter(entry.frontmatter);
  const sections = [
    `# ${entry.frontmatter.title}`,
    "",
    entry.summary,
    "",
    "## Detail",
    entry.detail,
  ];
  if (entry.context) {
    sections.push("", "## Context", entry.context);
  }
  return `${fm}\n${sections.join("\n")}\n`;
}

// ── Internal ────────────────────────────────────────────────────────────────

/**
 * Canonical frontmatter key order. YAML is rendered in THIS order regardless of
 * the object's insertion order, so an LLM's key ordering can never leak into the
 * file. This is the single biggest source of historical drift (e.g. `subcategory`
 * floating to the bottom when the model omitted it from its JSON).
 */
const FRONTMATTER_ORDER = [
  "id",
  "title",
  "type",
  "tag",
  "domain",
  "subcategory",
  "status",
  "authority",
  "confidence",
  "related",
  "supersedes",
  "sources",
  "created",
  "updated",
  "expires",
  "asOf",
  "historical",
] as const;

/**
 * Optional fields that are OMITTED entirely when empty, rather than emitted as a
 * blank-value line (e.g. `subcategory: `). Keeps live entries clean while still
 * surfacing provenance fields only when they carry signal.
 */
const OMIT_WHEN_EMPTY = new Set([
  "tag",
  "subcategory",
  "expires",
  "asOf",
]);

/**
 * Fields whose array items are entry ids and should be written as Obsidian
 * wikilinks (`"[[id]]"`) so they are clickable + appear in the graph. Quoted
 * because an unquoted `- [[id]]` is a nested YAML flow sequence. The parser
 * strips the brackets back to bare ids on read (see unwrapScalar).
 */
const LINK_FIELDS = new Set(["related", "supersedes"]);

/** Render just the `---` frontmatter block in canonical key order. */
export function renderFrontmatter(fm: EntryFrontmatter): string {
  return renderFrontmatterFromRecord(fm as unknown as Record<string, unknown>);
}

function renderFrontmatterFromRecord(fields: Record<string, unknown>): string {
  const seen = new Set<string>();
  const keys = [
    ...FRONTMATTER_ORDER.filter((k) => k in fields),
    // Preserve any unknown keys deterministically (sorted) after known ones.
    ...Object.keys(fields)
      .filter((k) => !(FRONTMATTER_ORDER as readonly string[]).includes(k))
      .sort(),
  ];
  const lines = ["---"];
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const value = fields[key];
    if (value === undefined || value === null) continue;
    // Booleans only render when true: avoids `historical: false` noise
    // on every live entry.
    if (value === false) continue;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed === "" && OMIT_WHEN_EMPTY.has(key)) continue;
      lines.push(`${key}: ${trimmed}`);
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        const asLink = LINK_FIELDS.has(key);
        for (const item of value) {
          lines.push(asLink ? `  - "[[${item}]]"` : `  - ${item}`);
        }
      }
      continue;
    }
    lines.push(`${key}: ${value}`);
  }
  lines.push("---");
  return lines.join("\n");
}
