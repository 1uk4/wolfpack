/**
 * Den index generator — renders INDEX.md from den topic frontmatter.
 * Pure code, same pattern as OM's index-render.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, atomicWrite } from "@wolfpack/engine";

interface DenTopicMeta {
  id: string;
  title: string;
  summary: string;
  updated: string;
  related: string[];
}

/**
 * Render and write INDEX.md for a wolf's den memory.
 */
export function renderDenIndex(denRoot: string): void {
  const topicsDir = join(denRoot, "memory", "topics");
  const itemsDir = join(denRoot, "memory", "items");

  const topics = scanDir(topicsDir);
  const items = scanDir(itemsDir);

  const lines: string[] = [
    "# Wolf Memory",
    "",
    `**${topics.length}** topics, **${items.length}** items`,
    "",
  ];

  if (topics.length > 0) {
    lines.push("## Topics", "");
    for (const t of topics) {
      const links = t.related.length > 0 ? ` [→ ${t.related.join(", ")}]` : "";
      lines.push(`- **${t.id}** — ${t.summary}${links}`);
    }
    lines.push("");
  }

  if (items.length > 0) {
    lines.push("## Items", "");
    for (const t of items) {
      lines.push(`- **${t.id}** — ${t.summary}`);
    }
    lines.push("");
  }

  atomicWrite(join(denRoot, "memory", "INDEX.md"), lines.join("\n"));
}

function scanDir(dir: string): DenTopicMeta[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(join(dir, f), "utf-8");
      const { fields } = parseFrontmatter(raw);
      return {
        id: String(fields.id ?? f.replace(/\.md$/, "")),
        title: String(fields.title ?? "Untitled"),
        summary: String(fields.summary ?? ""),
        updated: String(fields.updated ?? ""),
        related: Array.isArray(fields.related)
          ? (fields.related as string[])
          : [],
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
