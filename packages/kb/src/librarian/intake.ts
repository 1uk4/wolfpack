/**
 * intake — drain all wolf inboxes, parse + validate contributions. Pure code.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import {
  type ParsedContribution,
  contentHash,
  type KbRoots,
} from "../shared/index.js";

/** List wolf subdirectories under librarian-ops/inbox/. */
function inboxWolves(opsRoot: string): string[] {
  const dir = join(opsRoot, "inbox");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Drain every inbox into parsed contributions. */
export function drainInbox(roots: KbRoots): ParsedContribution[] {
  const out: ParsedContribution[] = [];
  for (const wolf of inboxWolves(roots.opsRoot)) {
    const dir = join(roots.opsRoot, "inbox", wolf);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const filePath = join(dir, file);
      const parsed = parseContribution(filePath);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}

function parseContribution(filePath: string): ParsedContribution | null {
  const raw = readFileSync(filePath, "utf-8");
  const { fields, body } = parseFrontmatter(raw);
  const from = fields.from ? String(fields.from) : null;
  const denTopicId = fields.den_topic_id ? String(fields.den_topic_id) : null;
  if (!from || !denTopicId) return null; // malformed — skip

  const content = body.trim();
  const hash = fields.content_hash
    ? String(fields.content_hash)
    : contentHash(content);

  return {
    from,
    host: fields.host ? String(fields.host) : undefined,
    denTopicId,
    change: (fields.change as "create" | "merge") ?? "merge",
    contentHash: hash,
    prevHash:
      fields.prev_hash && String(fields.prev_hash) !== "null"
        ? String(fields.prev_hash)
        : null,
    domainHint: fields.domain_hint ? String(fields.domain_hint) : "",
    sourceCreated: fields.source_created ? String(fields.source_created) : undefined,
    sourceUpdated: fields.source_updated ? String(fields.source_updated) : undefined,
    dateBasis: fields.date_basis
      ? (String(fields.date_basis) as ParsedContribution["dateBasis"])
      : undefined,
    dateConfidence: fields.date_confidence
      ? (String(fields.date_confidence) as ParsedContribution["dateConfidence"])
      : undefined,
    currency: fields.currency
      ? (String(fields.currency) as ParsedContribution["currency"])
      : undefined,
    sourcePath: fields.source_path ? String(fields.source_path) : undefined,
    origin: fields.origin
      ? (String(fields.origin) as ParsedContribution["origin"])
      : undefined,
    graduation:
      fields.graduation === "feature" || fields.graduation === "hub"
        ? fields.graduation
        : undefined,
    entryId: fields.entry_id ? String(fields.entry_id) : undefined,
    final: fields.final === true || fields.final === "true" ? true : undefined,
    partOf: fields.part_of ? String(fields.part_of) : undefined,
    summary: content.split("\n\n")[0] ?? "",
    session: fields.session ? String(fields.session) : undefined,
    submitted: fields.submitted ? String(fields.submitted) : "",
    body: content,
    filePath,
  };
}
