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

function readDomainInfo(domain: string, kbBase?: string): DomainInfo {
  let label = domain;
  let description = "";
  const topics: string[] = [];

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

  return { name: domain, label, description, topics };
}

export function buildDomainContext(
  domains: string[],
  kbBase?: string,
): string {
  if (domains.length <= 1) return "";

  const infos = domains.map((d) => readDomainInfo(d, kbBase));

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

/**
 * Single-domain context block for the crawl consolidation prompt. Unlike
 * `buildDomainContext` (which is for multi-domain classification), this always
 * emits a block — the crawl's domain is pinned by the plan, and the LLM uses it
 * to shape the entry to fit the domain's existing landscape and avoid restating
 * what nearby sections already cover.
 *
 * Returns "" only when the KB has nothing to say about the domain (no meta,
 * no digest).
 */
export function buildCrawlDomainContext(
  domain: string,
  kbBase?: string,
): string {
  const d = readDomainInfo(domain, kbBase);
  const descriptive = d.description && d.description !== d.name;
  if (!descriptive && d.topics.length === 0) return "";

  const lines = [`DOMAIN: ${d.name}`];
  if (descriptive) lines.push(`Scope: ${d.description || d.label}`);
  if (d.topics.length > 0) {
    lines.push(`Existing top sections: ${d.topics.join(", ")}`);
  }
  return lines.join("\n");
}
