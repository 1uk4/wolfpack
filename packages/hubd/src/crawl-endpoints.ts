/**
 * Hub endpoints for the pack-wide KB crawl (work-wolfpack-ZBZPAZ9):
 *   GET  /v1/contributions/receipts   which den topics the curator has curated for the calling wolf
 *   POST /v1/contributions/check      which (topic, hash) pairs the hub already holds, so a release can skip them
 *   POST /v1/kb/match                 best KB matches per candidate entry, for the release review (new / update / duplicate)
 * plus the hub-side secret check on incoming contributions (`secretFindings`).
 *
 * Embeddings: Ollama (env HUBD_OLLAMA_URL, HUBD_OLLAMA_MODEL; unset URL = text matching only). If Ollama is unset, unreachable, slow
 * or answers badly, the whole response falls back to text matching and says so in `method`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { scanSecrets } from "@wolfpack/memory";
import { contributionFileName } from "@wolfpack/kb/client";
import type { KbRoots } from "@wolfpack/kb/shared";
import { contributionsDir } from "./layout.js";

// ── receipts / check ────────────────────────────────────────────────────────

const TAIL = /-[0-9a-f]{10}\.md$/;

/** Den topic ids in `<lane>/_processed/` (handled by the curator). Files are `<denTopicId>-<hash10>.md`. */
export function curatedTopics(dataDir: string, wolf: string, inboxRoot?: string): string[] {
  const dir = join(inboxRoot ?? join(dataDir, "kb", "ops", "contributions"), wolf, "_processed");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return [...new Set(names.filter((n) => TAIL.test(n) && !n.startsWith(".")).map((n) => n.replace(TAIL, "")))].sort();
}

export const MAX_CHECK_ITEMS = 2000;

/** denTopicIds whose exact (topic, contentHash) the hub already holds for `wolf` (pending or curated). Items without a hash are never unchanged. */
export function unchangedItems(dataDir: string, wolf: string, items: { denTopicId: string; contentHash?: string }[], inboxRoot?: string): string[] {
  const lane = inboxRoot ? join(inboxRoot, wolf) : contributionsDir(dataDir, wolf);
  const out = new Set<string>();
  for (const it of items) {
    if (!it.contentHash) continue;
    let name: string;
    try {
      name = contributionFileName(it.denTopicId, it.contentHash);
    } catch {
      continue; // an unsafe id or bad hash cannot be stored, so it is not held
    }
    if (existsSync(join(lane, name)) || existsSync(join(lane, "_processed", name))) out.add(it.denTopicId);
  }
  return [...out];
}

// ── secret check ────────────────────────────────────────────────────────────

export interface SecretFinding {
  /** Which entry (the denTopicId, or the candidate title). */
  entry: string;
  /** Which field held it. */
  field: string;
  /** Pattern kind, e.g. "token". Never the value. */
  pattern: string;
}

/**
 * SEAM (work-wolfpack-VO2wX3I): the hub-side secret check. Today it reuses the work-item scanner (`scanSecrets`); the shared secret-block
 * module will replace this one function. Returns the pattern names found in the fields, never the matched text.
 */
export function secretFindings(entry: string, fields: Record<string, string | undefined>): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const [field, text] of Object.entries(fields)) {
    if (!text) continue;
    for (const f of scanSecrets(text).findings) out.push({ entry, field, pattern: f.kind });
  }
  return out;
}

// ── kb match ────────────────────────────────────────────────────────────────

/** "duplicate" needs the best match's score at or above this AND a nearly identical body. */
export const DUPLICATE_SCORE = 0.9;
/** Body similarity (token-shingle Jaccard, see `bodySimilarity`) at or above this counts as nearly identical. */
export const DUPLICATE_BODY_SIMILARITY = 0.85;
/** Best score at or above this (below duplicate) = "update" of that entry; below = "new". */
export const UPDATE_SCORE = 0.6;
export const MAX_CANDIDATES = 50;
export const MAX_MATCHES = 5;
export const OLLAMA_TIMEOUT_MS = 8000;

const tokens = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

/** Jaccard overlap of 3-word shingles of the normalised (lowercased, punctuation-free) text; texts under 3 words use single words. 1 = identical, 0 = disjoint. */
export function bodySimilarity(a: string, b: string): number {
  const sh = (t: string[]) => {
    const n = t.length >= 3 ? 3 : 1;
    const s = new Set<string>();
    for (let i = 0; i + n <= t.length; i++) s.add(t.slice(i, i + n).join(" "));
    return s;
  };
  const A = sh(tokens(a));
  const B = sh(tokens(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface KbDoc {
  domain: string;
  id: string;
  title: string;
  body: string;
}

/** Every entry under `<kbBase>/domains/<d>/entries/*.md` (optionally one domain). Title from the frontmatter (else the first heading, else the id). */
export function loadKbDocs(roots: Pick<KbRoots, "kbBase">, domain?: string): KbDoc[] {
  const base = join(roots.kbBase, "domains");
  let domains: string[];
  try {
    domains = domain ? [domain] : readdirSync(base);
  } catch {
    return [];
  }
  const docs: KbDoc[] = [];
  for (const d of domains) {
    if (!/^[A-Za-z0-9._-]+$/.test(d)) continue;
    const dir = join(base, d, "entries");
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".md") && !n.startsWith("."));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        const p = join(dir, n);
        if (!statSync(p).isFile()) continue;
        const raw = readFileSync(p, "utf8");
        const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
        const body = fm ? raw.slice(fm[0].length) : raw;
        const t = fm && /^title:\s*(.+)$/m.exec(fm[1]!);
        const title = (t ? t[1]!.trim().replace(/^["']|["']$/g, "") : /^#\s+(.+)$/m.exec(body)?.[1]) || n.replace(/\.md$/, "");
        docs.push({ domain: d, id: n.replace(/\.md$/, ""), title, body });
      } catch {
        /* unreadable entry: skipped */
      }
    }
  }
  return docs;
}

export interface MatchCandidate {
  title: string;
  body: string;
  /** Restrict matching to one KB domain. */
  domain?: string;
}
export interface KbMatch {
  domain: string;
  id: string;
  title: string;
  score: number;
  /** Body similarity to the candidate (0-1). */
  bodySimilarity: number;
}
export type MatchLabel = "new" | "update" | "duplicate";
export interface MatchResult {
  title: string;
  label: MatchLabel;
  matches: KbMatch[];
}
export interface MatchResponse {
  method: "embeddings" | "text";
  /** Why text matching was used when embeddings were not (no URL configured, unreachable, bad answer). Absent for embeddings. */
  fallback?: string;
  results: MatchResult[];
}

export interface OllamaConfig {
  url?: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}
export const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";

export function ollamaFromEnv(env: Record<string, string | undefined> = process.env): OllamaConfig {
  return { url: env.HUBD_OLLAMA_URL?.trim() || undefined, model: env.HUBD_OLLAMA_MODEL?.trim() || undefined };
}

const clip = (s: string) => s.slice(0, 6000);

/** Embeddings via Ollama `/api/embed` (batched). Throws on any failure. */
async function embed(o: OllamaConfig, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    const res = await (o.fetch ?? fetch)(`${o.url!.replace(/\/+$/, "")}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: o.model ?? DEFAULT_OLLAMA_MODEL, input: texts.slice(i, i + 32).map(clip) }),
      signal: AbortSignal.timeout(o.timeoutMs ?? OLLAMA_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`ollama answered ${res.status}`);
    const j = (await res.json()) as { embeddings?: unknown };
    const e = j.embeddings;
    const n = Math.min(32, texts.length - i);
    if (!Array.isArray(e) || e.length !== n || !e.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number"))) throw new Error("ollama answered with no usable embeddings");
    out.push(...(e as number[][]));
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! * a[i]!; y += b[i]! * b[i]!; }
  return x && y ? Math.max(0, d / Math.sqrt(x * y)) : 0;
}

/** Text score: the larger of the title token overlap and the body shingle overlap blended with title (0-1). Deterministic, no model. */
function textScore(c: MatchCandidate, d: KbDoc, bodySim: number): number {
  const ta = new Set(tokens(c.title));
  const tb = new Set(tokens(d.title));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const titleSim = ta.size + tb.size === 0 ? 0 : inter / (ta.size + tb.size - inter);
  return Math.max(bodySim, 0.4 * titleSim + 0.6 * bodySim, 0.8 * titleSim);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function label(best: KbMatch | undefined): MatchLabel {
  if (!best) return "new";
  if (best.score >= DUPLICATE_SCORE && best.bodySimilarity >= DUPLICATE_BODY_SIMILARITY) return "duplicate";
  return best.score >= UPDATE_SCORE ? "update" : "new";
}

/** Match candidates against the KB. Embeddings when Ollama is configured and answers; otherwise text, with the reason in `fallback`. */
export async function matchKb(roots: Pick<KbRoots, "kbBase">, candidates: MatchCandidate[], ollama: OllamaConfig = {}, allow?: (domain: string) => boolean): Promise<MatchResponse> {
  const docsAll = loadKbDocs(roots).filter((d) => !allow || allow(d.domain));
  const docsFor = (c: MatchCandidate) => (c.domain ? docsAll.filter((d) => d.domain === c.domain) : docsAll);
  let vec: { cands: number[][]; docs: number[][] } | undefined;
  let fallback: string | undefined;
  if (!ollama.url) fallback = "no embedding service configured";
  else if (docsAll.length > 0) {
    try {
      const all = await embed(ollama, [...candidates.map((c) => `${c.title}\n\n${c.body}`), ...docsAll.map((d) => `${d.title}\n\n${d.body}`)]);
      vec = { cands: all.slice(0, candidates.length), docs: all.slice(candidates.length) };
    } catch (e) {
      // The detail (it can carry the service URL) stays in the hub log; the response gets a fixed reason.
      console.warn(`hubd: kb/match: embeddings unavailable, using text matching: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
      fallback = "embedding service unavailable";
    }
  } else vec = { cands: [], docs: [] }; // empty KB: nothing to embed, nothing can match
  const results = candidates.map((c, ci): MatchResult => {
    const scored = docsFor(c).map((d): KbMatch => {
      const bs = bodySimilarity(c.body, d.body);
      const score = vec ? cosine(vec.cands[ci]!, vec.docs[docsAll.indexOf(d)]!) : textScore(c, d, bs);
      return { domain: d.domain, id: d.id, title: d.title, score: round(score), bodySimilarity: round(bs) };
    });
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const matches = scored.filter((m) => m.score > 0).slice(0, MAX_MATCHES);
    return { title: c.title, label: label(matches[0]), matches };
  });
  return vec ? { method: "embeddings", results } : { method: "text", fallback, results };
}
