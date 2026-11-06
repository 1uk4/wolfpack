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
import { contributionFileName } from "@wolfpack/kb/client";
import { contentHash, isSafeSegment, type KbRoots } from "@wolfpack/kb/shared";
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

// ── kb match ────────────────────────────────────────────────────────────────

/**
 * Label thresholds, PER METHOD. ALL UNCALIBRATED first guesses (no labelled corpus has been run through them yet). The two scales differ:
 * an embedding score is a cosine similarity (related prose is routinely 0.5+, so "update" starts higher), the text score is a token-overlap
 * measure that is near 0 for unrelated text. Calibrate each against real release reviews before trusting a label unreviewed.
 * duplicate = best score >= duplicateScore AND body similarity (shingle Jaccard) >= duplicateBody; update = best score >= update; else new.
 */
export interface Thresholds {
  duplicateScore: number;
  duplicateBody: number;
  update: number;
}
export const EMBEDDING_THRESHOLDS: Thresholds = { duplicateScore: 0.9, duplicateBody: 0.85, update: 0.6 }; // uncalibrated
export const TEXT_THRESHOLDS: Thresholds = { duplicateScore: 0.9, duplicateBody: 0.85, update: 0.4 }; // uncalibrated
/** Kept for callers/tests that name the duplicate body bar (same value for both methods today). */
export const DUPLICATE_BODY_SIMILARITY = EMBEDDING_THRESHOLDS.duplicateBody;
export const MAX_MATCHES = 5;
export const OLLAMA_TIMEOUT_MS = 8000;
/** Overall time budget for all embedding calls of one match request; past it the request falls back to text. */
export const OLLAMA_DEADLINE_MS = 20_000;
/** Most KB docs embedded (cache misses) in one request; the rest wait for the next request (the cache fills up over calls). */
export const MAX_DOCS_EMBEDDED_PER_CALL = 200;
export const EMBED_BATCH = 32;

const tokens = (s: string): string[] => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

/** 3-word shingles of the normalised (lowercased, punctuation-free) text; texts under 3 words use single words. */
export function shingles(text: string): Set<string> {
  const t = tokens(text);
  const n = t.length >= 3 ? 3 : 1;
  const s = new Set<string>();
  for (let i = 0; i + n <= t.length; i++) s.add(t.slice(i, i + n).join(" "));
  return s;
}
function jaccard<T>(A: Set<T>, B: Set<T>): number {
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
/** Jaccard overlap of the shingle sets. 1 = identical, 0 = disjoint. */
export function bodySimilarity(a: string, b: string): number {
  return jaccard(shingles(a), shingles(b));
}

export interface KbDoc {
  domain: string;
  id: string;
  title: string;
  body: string;
}

/** Entries under `<kbBase>/domains/<d>/entries/*.md` for the given domains (default: every domain on disk). Title from the frontmatter (else the first heading, else the id). */
export function loadKbDocs(roots: Pick<KbRoots, "kbBase">, domains?: Iterable<string>): KbDoc[] {
  const base = join(roots.kbBase, "domains");
  let list: string[];
  try {
    list = domains ? [...new Set(domains)] : readdirSync(base);
  } catch {
    return [];
  }
  const docs: KbDoc[] = [];
  for (const d of list) {
    if (!isSafeSegment(d)) continue; // caller-supplied names: no "..", no separators
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
  /** Why text matching was used when embeddings were not (nothing to match, no service, unreachable, timed out, bad answer). Absent for embeddings. */
  fallback?: string;
  results: MatchResult[];
}

export interface OllamaConfig {
  url?: string;
  model?: string;
  fetch?: typeof fetch;
  /** Per request, ms (default OLLAMA_TIMEOUT_MS). */
  timeoutMs?: number;
  /** For the whole match request, ms (default OLLAMA_DEADLINE_MS). */
  deadlineMs?: number;
  /** Cap on docs embedded per request (default MAX_DOCS_EMBEDDED_PER_CALL). */
  maxDocs?: number;
}
export const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";

export function ollamaFromEnv(env: Record<string, string | undefined> = process.env): OllamaConfig {
  return { url: env.HUBD_OLLAMA_URL?.trim() || undefined, model: env.HUBD_OLLAMA_MODEL?.trim() || undefined };
}

/** In-memory doc embeddings keyed by model + domain/id and validated by a hash of the embedded text, so an edited entry is re-embedded. Bounded (oldest dropped). */
export interface EmbeddingCache {
  get(key: string, sig: string): number[] | undefined;
  set(key: string, sig: string, vec: number[]): void;
  clear(): void;
  readonly size: number;
}
export function createEmbeddingCache(max = 5000): EmbeddingCache {
  const m = new Map<string, { sig: string; vec: number[] }>();
  return {
    get: (k, sig) => (m.get(k)?.sig === sig ? m.get(k)!.vec : undefined),
    set(k, sig, vec) {
      m.delete(k);
      m.set(k, { sig, vec });
      while (m.size > max) m.delete(m.keys().next().value as string);
    },
    clear: () => m.clear(),
    get size() {
      return m.size;
    },
  };
}

/** A failed embedding step. `reason` is safe to show (no URL, no payload); `detail` goes to the hub log. */
class EmbedFailure extends Error {
  constructor(readonly reason: string, readonly detail: string) {
    super(detail);
  }
}

const clip = (t: string) => t.slice(0, 6000);

/** Embeddings for `texts` via Ollama `/api/embed`, in batches of EMBED_BATCH under the overall deadline. Throws EmbedFailure. */
async function embed(o: OllamaConfig, texts: string[], deadlineAt: number, label: string): Promise<number[][]> {
  const out: number[][] = [];
  const batches = Math.ceil(texts.length / EMBED_BATCH);
  for (let i = 0, b = 1; i < texts.length; i += EMBED_BATCH, b++) {
    const where = `${label} batch ${b}/${batches}`;
    const left = deadlineAt - Date.now();
    if (left <= 0) throw new EmbedFailure(`embedding deadline reached before ${where}`, "deadline");
    let res: Response;
    try {
      res = await (o.fetch ?? fetch)(`${o.url!.replace(/\/+$/, "")}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: o.model ?? DEFAULT_OLLAMA_MODEL, input: texts.slice(i, i + EMBED_BATCH).map(clip) }),
        signal: AbortSignal.timeout(Math.min(o.timeoutMs ?? OLLAMA_TIMEOUT_MS, left)),
      });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new EmbedFailure(`${where} ${timedOut ? "timed out" : "unreachable"}`, e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new EmbedFailure(`${where} failed (service answered ${res.status})`, `status ${res.status}`);
    let e: unknown;
    try {
      e = ((await res.json()) as { embeddings?: unknown }).embeddings;
    } catch {
      throw new EmbedFailure(`${where} failed (unreadable answer)`, "bad json");
    }
    const n = Math.min(EMBED_BATCH, texts.length - i);
    if (!Array.isArray(e) || e.length !== n || !e.every((v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x)))) {
      throw new EmbedFailure(`${where} failed (malformed embeddings)`, "malformed embeddings");
    }
    out.push(...(e as number[][]));
  }
  return out;
}

function cosine(a: number[], b: number[]): number {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! * a[i]!; y += b[i]! * b[i]!; }
  return x && y ? Math.max(0, d / Math.sqrt(x * y)) : 0;
}

/** Text score (0-1): the larger of the body shingle overlap, a title/body blend, and a damped title overlap. No model. */
function textScore(titleSim: number, bodySim: number): number {
  return Math.max(bodySim, 0.4 * titleSim + 0.6 * bodySim, 0.8 * titleSim);
}

const round = (n: number) => Math.round(n * 1000) / 1000;

function label(best: KbMatch | undefined, t: Thresholds): MatchLabel {
  if (!best) return "new";
  if (best.score >= t.duplicateScore && best.bodySimilarity >= t.duplicateBody) return "duplicate";
  return best.score >= t.update ? "update" : "new";
}

interface PreparedDoc extends KbDoc {
  key: string;
  sig: string;
  text: string;
  sh: Set<string>;
  tt: Set<string>;
}

/**
 * Match candidates against the KB. Only the domains in scope are read: a candidate's own `domain`, else every domain in `readable`
 * (undefined = every domain on disk). Embeddings when Ollama is configured and answers in time; otherwise text, with the reason in `fallback`.
 * An empty scope answers method "text" (nothing was embedded).
 */
export async function matchKb(roots: Pick<KbRoots, "kbBase">, candidates: MatchCandidate[], ollama: OllamaConfig = {}, readable?: Set<string>, cache: EmbeddingCache = createEmbeddingCache()): Promise<MatchResponse> {
  const wanted = new Set<string>();
  let allOfScope = false;
  for (const c of candidates) {
    if (c.domain) {
      if (!readable || readable.has(c.domain)) wanted.add(c.domain);
    } else allOfScope = true;
  }
  if (allOfScope) for (const d of readable ?? listDomainDirs(roots)) wanted.add(d);
  const docs: PreparedDoc[] = loadKbDocs(roots, wanted).map((d) => {
    const text = `${d.title}\n\n${d.body}`;
    return { ...d, key: `${d.domain}/${d.id}`, text, sig: contentHash(text), sh: shingles(d.body), tt: new Set(tokens(d.title)) };
  });
  const byDomain = new Map<string, PreparedDoc[]>();
  for (const d of docs) (byDomain.get(d.domain) ?? byDomain.set(d.domain, []).get(d.domain)!).push(d);
  const scopeOf = (c: MatchCandidate): PreparedDoc[] => (c.domain ? byDomain.get(c.domain) ?? [] : docs);

  let fallback: string | undefined;
  let vec: { cands: number[][]; docs: Map<string, number[]> } | undefined;
  if (docs.length === 0) fallback = "no KB entries in scope to match against";
  else if (!ollama.url) fallback = "no embedding service configured";
  else {
    const model = ollama.model ?? DEFAULT_OLLAMA_MODEL;
    const deadlineAt = Date.now() + (ollama.deadlineMs ?? OLLAMA_DEADLINE_MS);
    try {
      const cands = await embed(ollama, candidates.map((c) => `${c.title}\n\n${c.body}`), deadlineAt, "candidate");
      const have = new Map<string, number[]>();
      const missing: PreparedDoc[] = [];
      for (const d of docs) {
        const v = cache.get(`${model}|${d.key}`, d.sig);
        if (v) have.set(d.key, v);
        else missing.push(d);
      }
      const maxDocs = ollama.maxDocs ?? MAX_DOCS_EMBEDDED_PER_CALL;
      const now = missing.slice(0, maxDocs);
      // Embed batch by batch and cache as we go, so a failure or the deadline keeps the work done and the next request converges.
      for (let i = 0; i < now.length; i += EMBED_BATCH) {
        const part = now.slice(i, i + EMBED_BATCH);
        const vs = await embed(ollama, part.map((d) => clip(d.text)), deadlineAt, "KB entry");
        part.forEach((d, j) => (cache.set(`${model}|${d.key}`, d.sig, vs[j]!), have.set(d.key, vs[j]!)));
      }
      if (missing.length > now.length) throw new EmbedFailure(`warming the embedding cache (${have.size} of ${docs.length} KB entries embedded; the rest follow on later requests)`, "cap");
      const dim = cands[0]!.length;
      if (cands.some((v) => v.length !== dim) || [...have.values()].some((v) => v.length !== dim)) {
        cache.clear(); // a different model/dimension: nothing cached is comparable
        throw new EmbedFailure("embedding dimensions differ between the candidates and the KB entries (model changed?)", "dimension mismatch");
      }
      vec = { cands, docs: have };
    } catch (e) {
      if (e instanceof EmbedFailure) {
        fallback = `embeddings unavailable: ${e.reason}`;
        console.warn(`hubd: kb/match: using text matching (${e.reason}; ${e.detail.slice(0, 160)})`);
      } else throw e;
    }
  }

  const thresholds = vec ? EMBEDDING_THRESHOLDS : TEXT_THRESHOLDS;
  const results = candidates.map((c, ci): MatchResult => {
    const csh = shingles(c.body);
    const ctt = new Set(tokens(c.title));
    const scored = scopeOf(c).map((d): KbMatch => {
      const bs = jaccard(csh, d.sh);
      const score = vec ? cosine(vec.cands[ci]!, vec.docs.get(d.key)!) : textScore(jaccard(ctt, d.tt), bs);
      return { domain: d.domain, id: d.id, title: d.title, score: round(score), bodySimilarity: round(bs) };
    });
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const matches = scored.filter((m) => m.score > 0).slice(0, MAX_MATCHES);
    return { title: c.title, label: label(matches[0], thresholds), matches };
  });
  return vec ? { method: "embeddings", results } : { method: "text", fallback, results };
}

function listDomainDirs(roots: Pick<KbRoots, "kbBase">): string[] {
  try {
    return readdirSync(join(roots.kbBase, "domains"));
  } catch {
    return [];
  }
}
