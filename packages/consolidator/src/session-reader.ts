/**
 * Session reader — reads OM's session memory output.
 *
 * OM writes topic files to .memory/<sessionId>/<topic>.md with frontmatter:
 *   id, title, summary, updated
 * Plus JOURNEY.md (no frontmatter, narrative prose) and INDEX.md (generated).
 *
 * This module reads those files as input for wolf-level consolidation.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";

export interface SessionTopic {
  id: string;
  title: string;
  summary: string;
  updated: string;
  body: string;
  filename: string;
}

export interface SessionMemory {
  sessionId: string;
  topics: SessionTopic[];
  journey: string | null;
}

const SKIP_FILES = new Set(["INDEX.md", "JOURNEY.md"]);

/**
 * Read all topic files from an OM session memory directory.
 */
export function readSessionMemory(
  memoryRoot: string,
  sessionId: string
): SessionMemory {
  const sessionDir = join(memoryRoot, sessionId);

  if (!existsSync(sessionDir)) {
    return { sessionId, topics: [], journey: null };
  }

  // Read topics
  const topics: SessionTopic[] = [];
  const files = readdirSync(sessionDir).filter(
    (f) => f.endsWith(".md") && !SKIP_FILES.has(f) && !f.startsWith(".")
  );

  for (const filename of files) {
    const raw = readFileSync(join(sessionDir, filename), "utf-8");
    const { fields, body } = parseFrontmatter(raw);

    topics.push({
      id: String(fields.id ?? filename.replace(/\.md$/, "")),
      title: String(fields.title ?? "Untitled"),
      summary: String(fields.summary ?? ""),
      updated: String(fields.updated ?? ""),
      body: body.trim(),
      filename,
    });
  }

  // Read journey
  const journeyPath = join(sessionDir, "JOURNEY.md");
  const journey = existsSync(journeyPath)
    ? readFileSync(journeyPath, "utf-8").trim() || null
    : null;

  return { sessionId, topics, journey };
}

/**
 * List all session IDs that have memory under .memory/
 */
export function listSessions(memoryRoot: string): string[] {
  if (!existsSync(memoryRoot)) return [];
  return readdirSync(memoryRoot).filter((entry) => {
    const full = join(memoryRoot, entry);
    // Session dirs are UUID-like, skip .runs and other dotfiles
    return !entry.startsWith(".") && existsSync(join(full));
  });
}
