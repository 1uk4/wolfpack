/**
 * commit — all file I/O for a sweep. Pure code. Entries are written FLAT;
 * classification lives in frontmatter so crystallization never moves files.
 */
import { existsSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { atomicWrite } from "@wolfpack/engine";
import {
  type KbRoots,
  type ParsedContribution,
  entriesDir,
  receiptsDir,
  rejectedDir,
  unclassifiedDir,
  now,
} from "../shared/index.js";
import type { Entry } from "../schema/knowledge.js";

/** Read an existing entry's raw markdown for merge input. */
export function readEntryMarkdown(
  roots: KbRoots,
  domain: string,
  id: string
): string | null {
  const path = join(entriesDir(roots, domain), `${id}.md`);
  return existsSync(path) ? readFileSync(path, "utf-8") : null;
}

export function writeReceipt(
  roots: KbRoots,
  wolf: string,
  c: ParsedContribution,
  outcome: string,
  detail: string
): void {
  const dir = receiptsDir(roots, wolf);
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    `from: ${c.from}`,
    `den_topic_id: ${c.denTopicId}`,
    `outcome: ${outcome}`,
    `processed: ${now()}`,
    "---",
    "",
    detail,
    "",
  ].join("\n");
  atomicWrite(join(dir, `${c.denTopicId}-${c.contentHash.slice(7, 17)}.md`), body);
}

/** Move a handled contribution out of the inbox into a sibling _processed/. */
export function markProcessed(c: ParsedContribution): void {
  if (!existsSync(c.filePath)) return;
  const dir = join(dirname(c.filePath), "_processed");
  mkdirSync(dir, { recursive: true });
  renameSync(c.filePath, join(dir, basename(c.filePath)));
}

/**
 * Quarantine a contribution that fits no declared domain. Entry-first still
 * holds (committed immediately) but into a Dewey-only holding area that is NEVER
 * mirrored — pending a human `wolfpack domain add`. Records the suggested name.
 */
export function quarantine(
  roots: KbRoots,
  c: ParsedContribution,
  suggestedDomain: string,
): void {
  const dir = unclassifiedDir(roots);
  mkdirSync(dir, { recursive: true });
  const body = [
    "---",
    `from: ${c.from}`,
    `den_topic_id: ${c.denTopicId}`,
    `suggested_domain: ${suggestedDomain}`,
    `content_hash: ${c.contentHash}`,
    `quarantined: ${now()}`,
    "---",
    "",
    c.summary,
    "",
    c.body,
    "",
  ].join("\n");
  atomicWrite(join(dir, `${c.denTopicId}-${c.contentHash.slice(7, 17)}.md`), body);
}

/** Never silently drop a rejected contribution — archive it for audit. */
export function archiveRejected(
  roots: KbRoots,
  wolf: string,
  c: ParsedContribution
): void {
  const dir = rejectedDir(roots, wolf);
  mkdirSync(dir, { recursive: true });
  if (existsSync(c.filePath)) {
    atomicWrite(
      join(dir, `${c.denTopicId}-${c.contentHash.slice(7, 17)}.md`),
      readFileSync(c.filePath, "utf-8")
    );
  }
}

/** Single commit per sweep. Best-effort; no-op if not a git repo. */
export function gitCommit(roots: KbRoots, message: string): void {
  try {
    execFileSync("git", ["-C", roots.kbBase, "add", "-A"], { stdio: "ignore" });
    execFileSync("git", ["-C", roots.kbBase, "commit", "-m", message], {
      stdio: "ignore",
    });
  } catch {
    /* not a git repo or nothing to commit — fine for scaffold */
  }
}

// ============================================================================
// Section-aware frontmatter (section, placement, typed relations)
// ============================================================================

/** YAML-safe double-quoted scalar. Titles contain ': ' (colon-space) which YAML
 *  would read as a nested key, so always quote to keep frontmatter valid. */
function yamlStr(s: string): string {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Render entry frontmatter + body. Writes section, placement, and typed relations.
 */
function renderEntry(entry: Entry): string {
  const lines: string[] = ["---"];

  // Core identity
  lines.push(`id: ${entry.id}`);
  lines.push(`title: ${yamlStr(entry.title)}`);
  lines.push(`domain: ${entry.domain}`);

  // Section placement
  lines.push(`section: ${entry.section}`);
  lines.push(`placement:`);
  lines.push(`  basis: ${entry.placement.basis}`);
  lines.push(`  fit: ${entry.placement.fit.toFixed(3)}`);

  // Kind (discriminated union)
  if (entry.kind.type === "other") {
    lines.push(`kind:`);
    lines.push(`  type: other`);
    lines.push(`  tag: ${entry.kind.tag}`);
  } else {
    lines.push(`kind: ${entry.kind.type}`);
  }

  // Lifecycle
  lines.push(`maturity: ${entry.maturity}`);
  lines.push(`authority: ${entry.authority}`);
  lines.push(`confidence: ${entry.confidence}`);
  lines.push(`currency: ${entry.currency}`);
  if (entry.verified) lines.push(`verified: true`);

  // Typed relations
  if (entry.relations.length > 0) {
    lines.push(`relations:`);
    for (const rel of entry.relations) {
      lines.push(`  - kind: ${rel.kind}`);
      lines.push(`    target: ${rel.target}`);
      lines.push(`    source: ${rel.source}`);
      if (rel.weight !== undefined) {
        lines.push(`    weight: ${rel.weight.toFixed(3)}`);
      }
    }
  }

  // Facets (controlled vocabulary — bareword slug values)
  if (Object.keys(entry.facets).length > 0) {
    lines.push(`facets:`);
    for (const [key, value] of Object.entries(entry.facets)) {
      lines.push(`  ${key}: ${value}`);
    }
  }

  // Properties (open attribute bag — quote values so free-form strings with
  // colons/#/quotes stay valid YAML and round-trip through the reader).
  if (entry.properties && Object.keys(entry.properties).length > 0) {
    lines.push(`properties:`);
    for (const [key, value] of Object.entries(entry.properties)) {
      lines.push(`  ${key}: ${yamlStr(value)}`);
    }
  }

  // Dates
  lines.push(`created: ${entry.created}`);
  lines.push(`updated: ${entry.updated}`);
  if (entry.asOf) lines.push(`asOf: ${entry.asOf}`);
  if (entry.expires) lines.push(`expires: ${entry.expires}`);

  // Content hash (integrity)
  lines.push(`contentHash: ${entry.contentHash}`);

  lines.push("---");
  lines.push("");
  lines.push(`# ${entry.title}`);
  lines.push("");
  lines.push(entry.summary);
  lines.push("");
  lines.push("## Detail");
  lines.push("");
  lines.push(entry.detail);

  if (entry.context) {
    lines.push("");
    lines.push("## Context");
    lines.push("");
    lines.push(entry.context);
  }

  return lines.join("\n") + "\n";
}

/**
 * Write a section-aware entry with typed relations.
 */
export function commitEntry(roots: KbRoots, entry: Entry): void {
  const dir = entriesDir(roots, entry.domain);
  mkdirSync(dir, { recursive: true });
  atomicWrite(join(dir, `${entry.id}.md`), renderEntry(entry));
}
