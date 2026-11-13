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
import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, atomicWrite, DEFAULT_CONSOLIDATION } from "@wolfpack/engine";

export interface TopicFile {
  id: string;
  title: string;
  summary: string;
  updated: string;
  body: string;
  domain?: string;
  /** Work tags (frontmatter). A topic carrying one is work knowledge and never promotes. */
  work?: string;
  feature?: string;
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
      domain: fields.domain ? String(fields.domain) : undefined,
      ...(fields.work ? { work: String(fields.work) } : {}),
      ...(fields.feature ? { feature: String(fields.feature) } : {}),
      filename,
    };
  });
}

/** Default cap on a session's topic count (`memory.consolidation.maxTopics`). */
export const DEFAULT_MAX_TOPICS: number = DEFAULT_CONSOLIDATION.maxTopics;
const EVICTED_DIR = "evicted";

/** Topics moved aside by evictOldTopics; promote reads them so eviction never loses knowledge. */
export function readEvictedTopics(root: string): TopicFile[] {
  return readTopics(join(root, EVICTED_DIR));
}

/**
 * Keep at most `max` topics in the session root: the least recently updated (frontmatter `updated`, else file mtime)
 * move to `<root>/evicted/`. Never deletes. Returns the ids moved.
 */
export function evictOldTopics(root: string, max: number = DEFAULT_MAX_TOPICS): string[] {
  const topics = readTopics(root);
  if (topics.length <= max) return [];
  // `updated` is written as UTC `YYYY-MM-DD HH:MM`; a zone-less stamp is read as UTC. Missing/garbled: file mtime.
  const stamp = (t: TopicFile): number => {
    const s = t.updated.trim().replace(" ", "T");
    const parsed = s ? Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`) : NaN;
    if (!Number.isNaN(parsed)) return parsed;
    try { return statSync(join(root, t.filename)).mtimeMs; } catch { return 0; } // file vanished: sorts as oldest
  };
  const oldest = topics
    .map((t) => ({ t, at: stamp(t) }))
    .sort((a, b) => a.at - b.at || (a.t.filename < b.t.filename ? -1 : a.t.filename > b.t.filename ? 1 : 0))
    .slice(0, topics.length - max);
  const dest = join(root, EVICTED_DIR);
  mkdirSync(dest, { recursive: true });
  for (const { t } of oldest) {
    // An older evicted file with the same name keeps its body under a dated name.
    if (existsSync(join(dest, t.filename))) preserveEvicted(dest, t.filename);
    renameSync(join(root, t.filename), join(dest, t.filename));
  }
  return oldest.map(({ t }) => t.id);
}

/** Undo evictOldTopics for the given ids (a failed run changes nothing). */
export function restoreEvicted(root: string, ids: readonly string[]): void {
  const want = new Set(ids);
  for (const t of readEvictedTopics(root)) {
    if (!want.has(t.id) || existsSync(join(root, t.filename))) continue;
    renameSync(join(root, EVICTED_DIR, t.filename), join(root, t.filename));
  }
}

/**
 * Before a run writes topic `id`: an evicted file with that id is renamed `<id>-evicted-<stamp>` (file name and
 * frontmatter id), so the new topic cannot hide or overwrite its body and promote still sees both.
 */
export function setAsideEvicted(root: string, id: string): void {
  const dest = join(root, EVICTED_DIR);
  if (existsSync(join(dest, `${id}.md`))) preserveEvicted(dest, `${id}.md`);
}

/** Set the id inside the frontmatter block only (insert if absent); the body is never touched. */
function withFrontmatterId(raw: string, id: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/.exec(raw);
  if (!m) return `---\nid: ${id}\n---\n\n${raw}`;
  const fm = /^id:.*$/m.test(m[1]) ? m[1].replace(/^id:.*$/m, `id: ${id}`) : `id: ${id}\n${m[1]}`;
  return `---\n${fm}\n---${raw.slice(m[0].length)}`;
}

function preserveEvicted(dest: string, filename: string): void {
  const base = filename.replace(/\.md$/, "");
  const newId = `${base}-evicted-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const raw = readFileSync(join(dest, filename), "utf-8");
  atomicWrite(join(dest, `${newId}.md`), withFrontmatterId(raw, newId));
  unlinkSync(join(dest, filename));
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
    domain?: string;
  }
): void {
  mkdirSync(root, { recursive: true });
  const lines = [
    "---",
    `id: ${topic.id}`,
    `title: ${topic.title}`,
    `summary: ${topic.summary}`,
    `updated: ${topic.updated}`,
    ...(topic.domain ? [`domain: ${topic.domain}`] : []),
    "---",
    "",
    topic.body,
    "",
  ];
  atomicWrite(join(root, `${topic.id}.md`), lines.join("\n"));
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
