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
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, atomicWrite } from "@wolfpack/engine";

export interface DenTopic {
  id: string;
  title: string;
  summary: string;
  updated: string;
  related: string[];
  body: string;
  filePath: string;
}

export interface DenConfig {
  /** Path to the wolf's den root (e.g. ~/wolves/dens/1uk4/) */
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
  const topicsDir = join(denRoot, "memory", "topics");
  if (!existsSync(topicsDir)) return [];

  const files = readdirSync(topicsDir).filter((f) => f.endsWith(".md"));
  const topics: DenTopic[] = [];

  for (const file of files) {
    const filePath = join(topicsDir, file);
    const raw = readFileSync(filePath, "utf-8");
    const { fields, body } = parseFrontmatter(raw);

    topics.push({
      id: String(fields.id ?? file.replace(/\.md$/, "")),
      title: String(fields.title ?? "Untitled"),
      summary: String(fields.summary ?? ""),
      updated: String(fields.updated ?? ""),
      related: Array.isArray(fields.related) ? (fields.related as string[]) : [],
      body: body.trim(),
      filePath,
    });
  }

  return topics;
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
  const records = getConsolidatedSessions(denRoot);
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
