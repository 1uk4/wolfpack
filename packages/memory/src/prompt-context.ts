/**
 * Prompt context rendering — shared functions for injecting memory context
 * into the system prompt. Used by both Pi-CLI and Pi-durable extensions.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Render den topics context for system prompt injection.
 * Lists topics with paths and summaries — wolves read full files on demand.
 */
export function renderDenContext(wolfDen: string, wolfName: string): string | null {
  try {
    const topicsDir = join(wolfDen, "memory", "topics");
    if (!existsSync(topicsDir)) return null;

    const files = readdirSync(topicsDir).filter((f) => f.endsWith(".md"));
    if (files.length === 0) return null;

    const topics: Array<{ id: string; summary: string; filePath: string }> = [];
    for (const file of files) {
      const filePath = join(topicsDir, file);
      const raw = readFileSync(filePath, "utf-8");
      const idMatch = raw.match(/^id:\s*(.+)$/m);
      const summaryMatch = raw.match(/^summary:\s*(.+)$/m);
      topics.push({
        id: idMatch?.[1]?.trim() ?? file.replace(/\.md$/, ""),
        summary: summaryMatch?.[1]?.trim() ?? "(no summary)",
        filePath,
      });
    }

    const lines = [
      `Wolf ${wolfName} has persistent memory from previous sessions (${topics.length} topic${topics.length !== 1 ? "s" : ""}).`,
      "Read a topic file when you need full details.",
      "",
      ...topics.map((t) => `- \`${t.filePath}\` -- ${t.summary}`),
    ];
    return lines.join("\n");
  } catch {
    return null;
  }
}

/**
 * Render KB access context for system prompt injection.
 * Lists subscribed domains with entry counts and section titles.
 * 
 * @param kbBase - Path to knowledge base root
 * @param subscribedDomains - Domain names the wolf is subscribed to (empty = show all)
 * @param maxSections - Max section titles to show per domain (default: 5)
 */
export function renderKbAccess(
  kbBase: string | undefined,
  subscribedDomains: string[],
  maxSections: number = 5
): string | null {
  if (!kbBase) return null;

  try {
    const domainsRoot = join(kbBase, "domains");
    if (!existsSync(domainsRoot)) return null;

    // Get domain names - filter by subscription if provided, otherwise show all
    let names: string[];
    if (subscribedDomains.length > 0) {
      names = subscribedDomains
        .filter((name) => existsSync(join(domainsRoot, name)))
        .sort();
    } else {
      names = readdirSync(domainsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    }

    if (names.length === 0) return null;

    const domainOutlines = names.map((name) => {
      const domainDir = join(domainsRoot, name);

      // Count entries
      let entries = 0;
      try {
        const entriesDir = join(domainDir, "entries");
        if (existsSync(entriesDir)) {
          entries = readdirSync(entriesDir).filter((f) => f.endsWith(".md")).length;
        }
      } catch { /* no entries dir */ }

      // Build section tree from digest for wolf navigation
      let sectionTree = "";
      try {
        const digestPath = join(domainDir, "_digest.json");
        if (existsSync(digestPath)) {
          const digest = JSON.parse(readFileSync(digestPath, "utf-8"));
          function walkSections(secs: Array<{ title?: string; children?: unknown[] }>, depth: number): string {
            let result = "";
            for (const s of secs) {
              const title = (s.title ?? "").replace(/^#+\s*/, "").trim();
              if (!title) continue;
              result += "\n" + "  ".repeat(depth + 1) + "- " + title;
              if (s.children && Array.isArray(s.children)) {
                result += walkSections(s.children as typeof secs, depth + 1);
              }
            }
            return result;
          }
          sectionTree = walkSections(digest.sections ?? [], 0);
        }
      } catch { /* no digest */ }

      const sectionStr = sectionTree ? ":" + sectionTree : "";
      return `- ${name} (${entries} entries)${sectionStr}`;
    });

    return [
      `You have access to ${names.length} shared knowledge domain(s):`,
      ...domainOutlines,
      `Each lives at ${domainsRoot}/<domain>/. When a question touches one of these`,
      `topics, read <domain>/INDEX.md, then entries/<id>.md on demand.`,
      `Trust entries (authority: curated).`,
    ].join("\n");
  } catch {
    return null;
  }
}
