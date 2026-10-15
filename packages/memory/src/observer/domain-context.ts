/**
 * Build a compact domain context block for the observer prompt.
 * Reads domain descriptions from the registry and section titles from KB digests.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

interface DomainInfo {
  name: string;
  label: string;
  description: string;
  topics: string[];
}

export function buildDomainContext(
  domains: string[],
  kbBase?: string,
): string {
  if (domains.length <= 1) return "";

  const infos: DomainInfo[] = [];

  for (const domain of domains) {
    let label = domain;
    let description = "";
    const topics: string[] = [];

    // Read label + description from domain meta.yaml
    if (kbBase) {
      const metaPath = join(kbBase, "domains", domain, "meta.yaml");
      if (existsSync(metaPath)) {
        try {
          const raw = readFileSync(metaPath, "utf-8");
          const labelMatch = raw.match(/label:\s*(.+)/);
          const descMatch = raw.match(/description:\s*(.+)/);
          if (labelMatch) label = labelMatch[1].trim();
          if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
        } catch { /* skip */ }
      }

      // Read section titles from _digest.json for topic examples
      const digestPath = join(kbBase, "domains", domain, "_digest.json");
      if (existsSync(digestPath)) {
        try {
          const digest = JSON.parse(readFileSync(digestPath, "utf-8"));
          const collectTitles = (sections: any[]) => {
            for (const s of sections) {
              if (s.title && topics.length < 6) topics.push(s.title);
              if (s.children) collectTitles(s.children);
            }
          };
          collectTitles(digest.sections ?? []);
        } catch { /* skip */ }
      }
    }

    infos.push({ name: domain, label, description, topics });
  }

  const lines = ["Domains this wolf subscribes to:"];
  for (const d of infos) {
    let line = `- ${d.name}: ${d.description || d.label}`;
    if (d.topics.length > 0) {
      line += `. Topics: ${d.topics.join(", ")}`;
    }
    lines.push(line);
  }

  return lines.join("\n");
}
