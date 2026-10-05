/**
 * Session memory — per-session topic files, journey, and index.
 * Extracted from OM. Agent-agnostic file operations.
 *
 * Layout under <root>/.memory/<sessionId>/:
 *   INDEX.md       — generated from topic frontmatter
 *   JOURNEY.md     — running descriptive history
 *   <topic>.md     — consolidator-authored topic files
 *   .runs/         — transient worker IPC (not part of the public interface)
 */
import { existsSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, atomicWrite } from "@wolfpack/engine";

export interface TopicFile {
  id: string;
  title: string;
  summary: string;
  updated: string;
  body: string;
  filename: string;
}

const SKIP_FILES = new Set(["INDEX.md", "JOURNEY.md"]);

/**
 * Resolve the session memory root.
 */
export function sessionMemoryRoot(cwd: string, sessionId: string): string {
  return join(cwd, ".memory", sessionId);
}

/**
 * Read all topic files from a session memory directory.
 */
export function readTopics(root: string): TopicFile[] {
  if (!existsSync(root)) return [];

  const files = readdirSync(root).filter(
    (f) => f.endsWith(".md") && !SKIP_FILES.has(f) && !f.startsWith(".")
  );

  return files.map((filename) => {
    const raw = readFileSync(join(root, filename), "utf-8");
    const { fields, body } = parseFrontmatter(raw);

    return {
      id: String(fields.id ?? filename.replace(/\.md$/, "")),
      title: String(fields.title ?? "Untitled"),
      summary: String(fields.summary ?? ""),
      updated: String(fields.updated ?? ""),
      body: body.trim(),
      filename,
    };
  });
}

/**
 * Read the session journey.
 */
export function readJourney(root: string): string | null {
  const journeyPath = join(root, "JOURNEY.md");
  if (!existsSync(journeyPath)) return null;
  const content = readFileSync(journeyPath, "utf-8").trim();
  return content || null;
}

/**
 * Write a topic file. Atomic (temp + rename).
 */
export function writeTopic(
  root: string,
  topic: {
    id: string;
    title: string;
    summary: string;
    updated: string;
    body: string;
  }
): void {
  mkdirSync(root, { recursive: true });
  const lines = [
    "---",
    `id: ${topic.id}`,
    `title: ${topic.title}`,
    `summary: ${topic.summary}`,
    `updated: ${topic.updated}`,
    "---",
    "",
    topic.body,
    "",
  ];
  atomicWrite(join(root, `${topic.id}.md`), lines.join("\n"));
}

/**
 * Write the journey file.
 */
export function writeJourney(root: string, content: string): void {
  mkdirSync(root, { recursive: true });
  atomicWrite(join(root, "JOURNEY.md"), content);
}

/**
 * Render and write INDEX.md from topic frontmatter.
 */
export function renderIndex(root: string): void {
  const topics = readTopics(root);
  const lines = [
    "# Memory",
    "",
    `${topics.length} topic${topics.length !== 1 ? "s" : ""}`,
    "",
    ...topics.map((t) => `- **${t.id}** — ${t.summary}`),
    "",
  ];
  atomicWrite(join(root, "INDEX.md"), lines.join("\n"));
}

/**
 * List all session IDs under .memory/.
 */
export function listSessionIds(cwd: string): string[] {
  const memoryDir = join(cwd, ".memory");
  if (!existsSync(memoryDir)) return [];
  return readdirSync(memoryDir).filter(
    (entry) => !entry.startsWith(".") && existsSync(join(memoryDir, entry))
  );
}
