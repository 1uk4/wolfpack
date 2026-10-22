/**
 * intake — drain all wolf inboxes, parse + validate contributions. Pure code.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import {
  type ParsedContribution,
  ANCHOR_RE,
  contentHash,
  hashHex,
  safeSegment,
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

/** Count pending top-level contributions per wolf (excludes _processed/, _bad/).
 *  Reads directory listings only: no file is opened. */
export function countPending(opsRoot: string): { total: number; wolves: string[] } {
  let total = 0;
  const wolves: string[] = [];
  for (const wolf of inboxWolves(opsRoot)) {
    const n = readdirSync(join(opsRoot, "inbox", wolf)).filter((f) => f.endsWith(".md")).length;
    if (n > 0) {
      total += n;
      wolves.push(`${wolf}(${n})`);
    }
  }
  return { total, wolves };
}

/** Drain every inbox into parsed contributions. A bad file is quarantined; it never fails the drain. */
export function drainInbox(roots: KbRoots): ParsedContribution[] {
  const out: ParsedContribution[] = [];
  for (const wolf of inboxWolves(roots.opsRoot)) {
    const dir = join(roots.opsRoot, "inbox", wolf);
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const filePath = join(dir, file);
      try {
        // The sender is the inbox directory, never the frontmatter.
        out.push(parseContribution(filePath, safeSegment(wolf, "inbox directory name")));
      } catch (err) {
        quarantineBad(filePath, err instanceof Error ? err.message : String(err));
      }
    }
  }
  return out;
}

/**
 * Move a malformed inbox file to `<inbox>/<wolf>/_bad/` with a `<file>.reason.txt`
 * sidecar, so it stops being retried and a human can see why.
 */
function quarantineBad(filePath: string, reason: string): void {
  try {
    const dir = join(dirname(filePath), "_bad");
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, basename(filePath));
    renameSync(filePath, dest);
    writeFileSync(`${dest}.reason.txt`, reason + "\n");
    console.warn(`intake: moved ${filePath} to _bad/ — ${reason}`);
  } catch (err) {
    console.warn(`intake: could not quarantine ${filePath} (${reason}): ${err instanceof Error ? err.message : err}`);
  }
}

function parseContribution(filePath: string, from: string): ParsedContribution {
  const raw = readFileSync(filePath, "utf-8");
  const { fields, body } = parseFrontmatter(raw);
  if (!fields.den_topic_id) throw new Error("missing den_topic_id");
  const denTopicId = safeSegment(String(fields.den_topic_id), "den_topic_id");

  const content = body.trim();
  const hash = fields.content_hash
    ? String(fields.content_hash)
    : contentHash(content);
  hashHex(hash); // reject a non-hex hash now, before it reaches a file name

  const anchor = fields.anchor ? String(fields.anchor) : undefined;
  if (anchor && !ANCHOR_RE.test(anchor)) throw new Error(`invalid anchor ${JSON.stringify(anchor)}`);

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
    // A sender may name the summary ; else the
    // first paragraph of the body.
    anchor: anchor,
    summary: fields.summary ? String(fields.summary) : content.split("\n\n")[0] ?? "",
    session: fields.session ? String(fields.session) : undefined,
    submitted: fields.submitted ? String(fields.submitted) : "",
    body: content,
    filePath,
  };
}
