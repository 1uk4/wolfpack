/**
 * Search — find related entries in the KB for a given claim or observation.
 * Pure code, no LLM. Keyword-based for now, upgradable to embeddings later.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "./parse.js";

export interface SearchHit {
  id: string;
  title: string;
  type: string;
  domain: string;
  score: number;
  filePath: string;
  summary: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Top hits that might be duplicates (score above threshold) */
  duplicates: SearchHit[];
}

/**
 * Search a domain's entries for keyword matches against a query string.
 * Returns hits sorted by relevance score (descending).
 */
export function searchDomain(
  entriesDir: string,
  query: string,
  options: { maxResults?: number; duplicateThreshold?: number } = {}
): SearchResult {
  const { maxResults = 20, duplicateThreshold = 0.7 } = options;

  if (!existsSync(entriesDir)) return { hits: [], duplicates: [] };

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return { hits: [], duplicates: [] };

  const files = readdirSync(entriesDir).filter((f) => f.endsWith(".md"));
  const scored: SearchHit[] = [];

  for (const file of files) {
    const filePath = join(entriesDir, file);
    const raw = readFileSync(filePath, "utf-8");
    const { fields, body } = parseFrontmatter(raw);

    const title = String(fields.title ?? "");
    const id = String(fields.id ?? file.replace(/\.md$/, ""));
    const type = String(fields.type ?? "");
    const domain = String(fields.domain ?? "");

    // Extract summary from body (first paragraph after frontmatter)
    const summary = body.split("\n\n")[0]?.trim() ?? "";

    const score = computeScore(queryTerms, title, summary, body);
    if (score > 0) {
      scored.push({ id, title, type, domain, score, filePath, summary });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const hits = scored.slice(0, maxResults);
  const duplicates = hits.filter((h) => h.score >= duplicateThreshold);

  return { hits, duplicates };
}

/**
 * Search across multiple domains.
 */
export function searchDomains(
  kbRoot: string,
  domains: string[],
  query: string,
  options: { maxResults?: number; duplicateThreshold?: number } = {}
): SearchResult {
  const allHits: SearchHit[] = [];

  for (const domain of domains) {
    const entriesDir = join(kbRoot, "domains", domain, "entries");
    const result = searchDomain(entriesDir, query, {
      ...options,
      maxResults: undefined,
    });
    allHits.push(...result.hits);
  }

  allHits.sort((a, b) => b.score - a.score);
  const maxResults = options.maxResults ?? 20;
  const duplicateThreshold = options.duplicateThreshold ?? 0.7;

  const hits = allHits.slice(0, maxResults);
  const duplicates = hits.filter((h) => h.score >= duplicateThreshold);

  return { hits, duplicates };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function computeScore(
  queryTerms: string[],
  title: string,
  summary: string,
  body: string
): number {
  const titleLower = title.toLowerCase();
  const summaryLower = summary.toLowerCase();
  const bodyLower = body.toLowerCase();

  let score = 0;
  for (const term of queryTerms) {
    // Title match is worth the most
    if (titleLower.includes(term)) score += 3;
    // Summary match is worth more than body
    if (summaryLower.includes(term)) score += 2;
    // Body match
    if (bodyLower.includes(term)) score += 1;
  }

  // Normalize by query length
  return score / (queryTerms.length * 3);
}
