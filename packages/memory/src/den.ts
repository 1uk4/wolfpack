/**
 * Den — the wolf's persistent memory store.
 *
 * Layout:
 *   dens/<wolf>/
 *     memory/
 *       topics/          # Consolidated knowledge topic files
 *       items/           # Live work items
 *       INDEX.md         # Generated from topic/item frontmatter
 *       JOURNEY.md       # Running history across all sessions
 *     sessions.json      # Tracks which sessions have been consolidated
 */
import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, atomicWrite } from "@wolfpack/engine";
import { assessTopic } from "@wolfpack/kb/client";

export interface DenTopic {
  id: string;
  title: string;
  summary: string;
  updated: string;
  related: string[];
  body: string;
  filePath: string;
  /** false = held back as private working memory: never emitted to the KB. */
  promotable: boolean;
  promotableReason?: string;
  /** Work tags (frontmatter), if any. A tagged topic never promotes. */
  work?: string;
  feature?: string;
}

export interface DenConfig {
  /** Path to the wolf's den root (e.g. ~/wolves/dens/owner/) */
  denRoot: string;
  /** Wolf name */
  wolfName: string;
}

/**
 * Ensure the den memory directory structure exists.
 */
export function ensureDenDirs(denRoot: string): void {
  mkdirSync(join(denRoot, "memory", "topics"), { recursive: true });
  mkdirSync(join(denRoot, "memory", "items"), { recursive: true });
}

/**
 * Read all existing topic files from the den.
 */
export function readDenTopics(denRoot: string): DenTopic[] {
  return readTopicFiles(join(denRoot, "memory", "topics")).map((f) => f.topic);
}

/** A den topic that reconcile moved to memory/archive/ once the KB absorbed it. */
export interface ArchivedDenTopic extends DenTopic {
  /** KB entry the receipt named; null for a reject. */
  absorbedInto: string | null;
  /** "" when the file has no absorbed_at: such a stint counts as the oldest. */
  absorbedAt: string;
  /** File mtime: breaks absorbed_at ties between stints of the same id. */
  mtimeMs: number;
}

/** Reconcile names a repeat stint `<id>-<hash10>.md`. */
const STINT_SUFFIX = /-[0-9a-f]{10}$/;

/**
 * Read every archived den topic (memory/archive/). The id comes from the
 * frontmatter, so a subject archived more than once (`<id>-<hash10>.md`) keeps
 * its real id; without one, the filename minus a trailing -<hash10> is used.
 * One file per stint: the same id can appear several times.
 */
export function readArchivedDenTopics(denRoot: string): ArchivedDenTopic[] {
  const dir = join(denRoot, "memory", "archive");
  return readTopicFiles(dir, (stem) => stem.replace(STINT_SUFFIX, "")).map(({ topic, fields, mtimeMs }) => ({
    ...topic,
    absorbedInto: fields.absorbed_into == null || String(fields.absorbed_into) === "null" ? null : String(fields.absorbed_into),
    absorbedAt: fields.absorbed_at == null ? "" : String(fields.absorbed_at),
    mtimeMs,
  }));
}

/**
 * Order of two stints of the same id: later absorbed_at is newer (a missing
 * absorbed_at is oldest); on a tie the newer file mtime wins (reconcile writes
 * each stint when it archives it), then the larger path, so the pick is
 * deterministic.
 */
function compareStints(a: ArchivedDenTopic, b: ArchivedDenTopic): number {
  return a.absorbedAt.localeCompare(b.absorbedAt) || a.mtimeMs - b.mtimeMs || a.filePath.localeCompare(b.filePath);
}

/**
 * The wolf's whole contribution set, for a rebuild of Dewey from scratch
 * (/wolf:resend-all, --emit-den): one topic per id, the latest version only.
 * A pending topic is newer than any archived stint of the same id; otherwise
 * the newest stint wins (compareStints). Rejected stints are included: a
 * rebuild lets Dewey decide again. Archived topics come first, oldest
 * absorbed first, then the pending ones.
 */
export function readResendTopics(denRoot: string): { archived: ArchivedDenTopic[]; pending: DenTopic[] } {
  const pending = readDenTopics(denRoot);
  const pendingIds = new Set(pending.map((t) => t.id));
  const latest = new Map<string, ArchivedDenTopic>();
  for (const t of readArchivedDenTopics(denRoot)) {
    if (pendingIds.has(t.id)) continue;
    const prev = latest.get(t.id);
    if (!prev || compareStints(t, prev) > 0) latest.set(t.id, t);
  }
  const archived = [...latest.values()].sort((a, b) => a.absorbedAt.localeCompare(b.absorbedAt) || a.id.localeCompare(b.id));
  return { archived, pending };
}

interface TopicFile {
  topic: DenTopic;
  fields: Record<string, unknown>;
  mtimeMs: number;
}

/** Parse every topic file in `dir`; `idFromStem` maps a filename stem to the id when the frontmatter has none. */
function readTopicFiles(dir: string, idFromStem: (stem: string) => string = (stem) => stem): TopicFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  return files.map((file) => {
    const filePath = join(dir, file);
    const { fields, body } = parseFrontmatter(readFileSync(filePath, "utf-8"));
    const topic: DenTopic = {
      id: String(fields.id ?? idFromStem(file.replace(/\.md$/, ""))),
      title: String(fields.title ?? "Untitled"),
      summary: String(fields.summary ?? ""),
      updated: String(fields.updated ?? ""),
      related: Array.isArray(fields.related) ? (fields.related as string[]) : [],
      body: body.trim(),
      filePath,
      promotable: String(fields.promotable) !== "false",
      promotableReason: fields.promotable_reason ? String(fields.promotable_reason) : undefined,
      ...(fields.work ? { work: String(fields.work) } : {}),
      ...(fields.feature ? { feature: String(fields.feature) } : {}),
    };
    return { topic, fields, mtimeMs: statSync(filePath).mtimeMs };
  });
}

/**
 * Read the den's journey file.
 */
export function readDenJourney(denRoot: string): string | null {
  const journeyPath = join(denRoot, "memory", "JOURNEY.md");
  if (!existsSync(journeyPath)) return null;
  const content = readFileSync(journeyPath, "utf-8").trim();
  return content || null;
}

/**
 * Write a topic file to the den.
 */
export function writeDenTopic(
  denRoot: string,
  topic: {
    id: string;
    title: string;
    summary: string;
    updated: string;
    related?: string[];
    body: string;
    domain?: string;
    /** Set false (with a reason) to keep the topic in the den but out of the KB. */
    promotable?: boolean;
    promotableReason?: string;
  }
): void {
  ensureDenDirs(denRoot);
  const filePath = join(denRoot, "memory", "topics", `${topic.id}.md`);

  const relatedArr = topic.related ?? [];
  const lines = [
    "---",
    `id: ${topic.id}`,
    `title: ${topic.title}`,
    `summary: ${topic.summary}`,
    `updated: ${topic.updated}`,
    ...(topic.domain ? [`domain: ${topic.domain}`] : []),
    ...(topic.promotable === false
      ? ["promotable: false", `promotable_reason: ${(topic.promotableReason ?? "").replace(/\s+/g, " ").trim()}`]
      : []),
  ];

  if (relatedArr.length > 0) {
    lines.push("related:");
    for (const r of relatedArr) {
      lines.push(`  - ${r}`);
    }
  } else {
    lines.push("related: []");
  }

  lines.push("---", "", topic.body, "");

  atomicWrite(filePath, lines.join("\n"));
}

/**
 * Write the den journey file.
 */
export function writeDenJourney(denRoot: string, content: string): void {
  ensureDenDirs(denRoot);
  atomicWrite(join(denRoot, "memory", "JOURNEY.md"), content);
}

// ── Session tracking ─────────────────────────────────────────────────────────

interface SessionRecord {
  sessionId: string;
  consolidatedAt: string;
  topicsProcessed: number;
}

/**
 * Get the list of sessions that have already been consolidated into this den.
 */
export function getConsolidatedSessions(denRoot: string): SessionRecord[] {
  const filePath = join(denRoot, "memory", "sessions.json");
  if (!existsSync(filePath)) return [];
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as SessionRecord[];
  } catch {
    return [];
  }
}

/**
 * Mark a session as consolidated.
 */
export function markSessionConsolidated(
  denRoot: string,
  sessionId: string,
  topicsProcessed: number
): void {
  ensureDenDirs(denRoot);
  const records = getConsolidatedSessions(denRoot).filter(
    (r) => r.sessionId !== sessionId
  );
  // Upsert: a session can be promoted many times as it grows; keep one record
  // per session (the latest), not a duplicate per promote.
  records.push({
    sessionId,
    consolidatedAt: new Date().toISOString(),
    topicsProcessed,
  });
  atomicWrite(
    join(denRoot, "memory", "sessions.json"),
    JSON.stringify(records, null, 2) + "\n"
  );
}

/**
 * Durability gate for a topic about to be written to the den. A session-log
 * topic stays in the den (`promotable: false`, with a reason) but is never
 * emitted to the KB. Rewriting the topic as current-state prose clears it.
 */
export function gateDenTopic(topic: { id: string; title: string; summary: string; body: string }): {
  promotable: boolean;
  promotableReason?: string;
} {
  const q = assessTopic(topic);
  return q.promotable ? { promotable: true } : { promotable: false, promotableReason: q.reason };
}
