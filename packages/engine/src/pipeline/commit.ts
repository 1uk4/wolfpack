/**
 * Commit — write entries, items, and claims to disk.
 * Pure code, no LLM. All writes are atomic (temp + rename).
 */
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Entry, EntryFrontmatter } from "../schemas/entry.js";
import type { LiveItem } from "../schemas/item.js";
import type { Claim } from "../schemas/claim.js";

/**
 * Atomic write — temp file + rename. Never leaves a half-written file.
 */
export function atomicWrite(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, filePath);
}

/**
 * Render an Entry to markdown with YAML frontmatter.
 */
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

/**
 * Render a LiveItem to markdown with YAML frontmatter.
 */
export function renderItem(item: LiveItem): string {
  const fields: Record<string, unknown> = {
    id: item.id,
    title: item.title,
    status: item.status,
    domain: item.domain,
    related: item.related,
    dependencies: item.dependencies,
    blockers: item.blockers,
    created: item.created,
    updated: item.updated,
  };

  const fm = renderFrontmatterFromRecord(fields);
  const sections = [`# ${item.title}`, "", item.summary];

  if (item.plan) {
    sections.push("", "## Plan", item.plan);
  }

  if (item.blockers.length > 0) {
    sections.push(
      "",
      "## Blockers",
      ...item.blockers.map((b) => `- ${b}`)
    );
  }

  return `${fm}\n${sections.join("\n")}\n`;
}

/**
 * Render a Claim to markdown for the Librarian inbox.
 */
export function renderClaim(claim: Claim): string {
  const fields: Record<string, unknown> = {
    from: claim.from,
    origin: claim.origin,
    domain: claim.domain,
    submitted: claim.submitted,
  };
  if (claim.session) fields.session = claim.session;

  const fm = renderFrontmatterFromRecord(fields);
  const body = [
    `# ${claim.title}`,
    "",
    "## The claim",
    claim.claim,
    "",
    "## Evidence",
    claim.evidence,
    "",
    "## Sources",
    ...claim.sources.map((s) => `- ${s}`),
  ].join("\n");

  return `${fm}\n${body}\n`;
}

/**
 * Write a receipt for a processed claim.
 */
export function writeReceipt(
  receiptsDir: string,
  submitter: string,
  claimFile: string,
  outcome: string,
  reasoning: string,
  entryId: string | null
): void {
  const dir = join(receiptsDir, submitter);
  mkdirSync(dir, { recursive: true });

  const receiptName = claimFile.replace(/\.md$/, "-receipt.md");
  const now = new Date().toISOString().split("T")[0];

  const content = [
    "---",
    `claim: "${claimFile}"`,
    `processed: ${now}`,
    `outcome: ${outcome}`,
    `entry: ${entryId ?? "null"}`,
    "---",
    "",
    `## Outcome: ${outcome.toUpperCase()}`,
    "",
    `## Reasoning`,
    reasoning,
    entryId ? `\n## Entry\n\`${entryId}\`` : "",
  ].join("\n");

  atomicWrite(join(dir, receiptName), content + "\n");
}

// ── Internal ────────────────────────────────────────────────────────────────

function renderFrontmatter(fm: EntryFrontmatter): string {
  return renderFrontmatterFromRecord(fm as unknown as Record<string, unknown>);
}

function renderFrontmatterFromRecord(
  fields: Record<string, unknown>
): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${item}`);
        }
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n");
}
