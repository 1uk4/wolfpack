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

function renderFrontmatter(fm: EntryFrontmatter): string {
  return renderFrontmatterFromRecord(fm as unknown as Record<string, unknown>);
}

function renderFrontmatterFromRecord(fields: Record<string, unknown>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}
