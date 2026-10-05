/**
 * Index generator — build navigable indexes with clusters from the link graph.
 * Pure code, no LLM.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./parse.js";
import { atomicWrite } from "./commit.js";

export interface IndexEntry {
  id: string;
  title: string;
  type: string;
  domain: string;
  subcategory?: string;
  status: string;
  authority: string;
  confidence: string;
  related: string[];
  updated: string;
}

export interface Cluster {
  name: string;
  coreId: string;
  coreTitle: string;
  entries: IndexEntry[];
}

/**
 * Scan a directory of entry files and extract index metadata.
 */
export function scanEntries(entriesDir: string): IndexEntry[] {
  if (!existsSync(entriesDir)) return [];

  const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
  const entries: IndexEntry[] = [];

  for (const file of files) {
    const raw = readFileSync(join(entriesDir, file), "utf-8");
    const { fields } = parseFrontmatter(raw);

    entries.push({
      id: String(fields.id ?? file.replace(/\.md$/, "")),
      title: String(fields.title ?? "Untitled"),
      type: String(fields.type ?? "unknown"),
      domain: String(fields.domain ?? "unknown"),
      subcategory: fields.subcategory ? String(fields.subcategory) : undefined,
      status: String(fields.status ?? "active"),
      authority: String(fields.authority ?? "claim"),
      confidence: String(fields.confidence ?? "medium"),
      related: Array.isArray(fields.related)
        ? (fields.related as string[])
        : [],
      updated: String(fields.updated ?? ""),
    });
  }

  return entries;
}

/**
 * Detect clusters from the link graph using connected components.
 * The "core" of each cluster is the entry with the most inbound links.
 */
export function detectClusters(entries: IndexEntry[]): Cluster[] {
  const idSet = new Set(entries.map((e) => e.id));
  const adjList = new Map<string, Set<string>>();

  // Build undirected adjacency list (only for ids that exist in this set)
  for (const entry of entries) {
    if (!adjList.has(entry.id)) adjList.set(entry.id, new Set());
    for (const relId of entry.related) {
      if (!idSet.has(relId)) continue;
      adjList.get(entry.id)!.add(relId);
      if (!adjList.has(relId)) adjList.set(relId, new Set());
      adjList.get(relId)!.add(entry.id);
    }
  }

  // BFS to find connected components
  const visited = new Set<string>();
  const clusters: Cluster[] = [];
  const entryMap = new Map(entries.map((e) => [e.id, e]));

  for (const entry of entries) {
    if (visited.has(entry.id)) continue;
    if (!adjList.has(entry.id) || adjList.get(entry.id)!.size === 0) continue;

    // BFS from this entry
    const component: string[] = [];
    const queue = [entry.id];
    visited.add(entry.id);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);

      for (const neighbor of adjList.get(current) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }

    // Only form a cluster if 3+ entries are connected
    if (component.length < 3) continue;

    // Core = most inbound links within the component
    const componentSet = new Set(component);
    let coreId = component[0];
    let maxLinks = 0;

    for (const id of component) {
      const inbound = (adjList.get(id) ?? new Set()).size;
      if (inbound > maxLinks) {
        maxLinks = inbound;
        coreId = id;
      }
    }

    const coreEntry = entryMap.get(coreId);
    clusters.push({
      name: coreEntry?.subcategory ?? coreEntry?.title ?? coreId,
      coreId,
      coreTitle: coreEntry?.title ?? coreId,
      entries: component.map((id) => entryMap.get(id)!).filter(Boolean),
    });
  }

  // Sort clusters by size (largest first)
  clusters.sort((a, b) => b.entries.length - a.entries.length);
  return clusters;
}

/**
 * Compute backlinks — for each entry, which other entries link TO it.
 */
export function computeBacklinks(
  entries: IndexEntry[]
): Map<string, string[]> {
  const backlinks = new Map<string, string[]>();

  for (const entry of entries) {
    for (const relId of entry.related) {
      if (!backlinks.has(relId)) backlinks.set(relId, []);
      backlinks.get(relId)!.push(entry.id);
    }
  }

  return backlinks;
}

/**
 * Render a domain INDEX.md with clusters, type breakdown, and entry list.
 */
export function renderDomainIndex(
  domain: string,
  entries: IndexEntry[]
): string {
  const active = entries.filter((e) => e.status === "active");
  const curated = active.filter((e) => e.authority === "curated");
  const clusters = detectClusters(active);
  const backlinks = computeBacklinks(active);

  // Group by type
  const byType = new Map<string, IndexEntry[]>();
  for (const e of active) {
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type)!.push(e);
  }

  const lines: string[] = [
    `# ${domain}`,
    "",
    `**${active.length}** active entries (${curated.length} curated)`,
    "",
  ];

  // Clusters section
  if (clusters.length > 0) {
    lines.push("## Clusters", "");
    for (const cluster of clusters) {
      lines.push(`### ${cluster.name} (${cluster.entries.length} entries)`);
      lines.push(`Core: ${cluster.coreId} — ${cluster.coreTitle}`);
      const others = cluster.entries
        .filter((e) => e.id !== cluster.coreId)
        .map((e) => `  - ${e.id} — ${e.title}`);
      lines.push(...others, "");
    }
  }

  // By type
  lines.push("## By Type", "");
  for (const [type, typeEntries] of [...byType.entries()].sort()) {
    lines.push(`### ${type} (${typeEntries.length})`, "");
    for (const e of typeEntries) {
      const bl = backlinks.get(e.id)?.length ?? 0;
      const linkInfo = bl > 0 ? ` [${bl} backlinks]` : "";
      lines.push(
        `- ${e.id} — ${e.title} (${e.confidence})${linkInfo}`
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate and write INDEX.md for a domain.
 */
export function generateDomainIndex(
  kbRoot: string,
  domain: string
): void {
  const entriesDir = join(kbRoot, "domains", domain, "entries");
  const entries = scanEntries(entriesDir);
  const content = renderDomainIndex(domain, entries);
  atomicWrite(join(kbRoot, "domains", domain, "INDEX.md"), content);
}
