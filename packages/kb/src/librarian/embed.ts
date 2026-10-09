/**
 * embed — the dedicated relevance model. A LOCAL embedding model served by
 * Ollama on the VPS where Dewey runs (NOT a chat LLM, NOT OpenRouter).
 *
 * Vectors are cached by content hash in den-local vectors/ and never synced —
 * fully derived/replayable from entries. Brute-force cosine in memory is the
 * right call at pack scale (hundreds–thousands of entries); no vector DB.
 *
 * Provisioned as part of adding the librarian wolf (infra/roles/ollama).
 */
import {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "@wolfpack/engine";
import {
  type KbRoots,
  type Registry,
  contentHash,
  vectorsDir,
  now,
} from "../shared/index.js";

export type Vector = number[];

export interface Embedder {
  embed(text: string, hash: string): Promise<Vector>;
}

export interface EmbedConfig {
  /** Ollama base URL — localhost on the VPS where Dewey + Ollama co-reside. */
  baseUrl: string;
  /** Embedding model (pulled during provisioning). */
  model: string;
}

/** Resolve config from env with lean local defaults. */
export function resolveEmbedConfig(): EmbedConfig {
  return {
    baseUrl: process.env.WOLFPACK_EMBED_URL ?? "http://localhost:11434",
    model: process.env.WOLFPACK_EMBED_MODEL ?? "nomic-embed-text",
  };
}

// ── cosine (pure) ────────────────────────────────────────────────────────────

/** Cosine similarity. Vectors are stored normalized → this is a dot product.
 *  Clamp to the mathematical [-1, 1] range: floating-point rounding on
 *  near-identical unit vectors can yield 1.0000000002, which overflows a
 *  placement fit score bounded to [0, 1] and (pre-clamp) hard-failed the whole
 *  contribution. The clamp only removes FP noise — for true unit vectors the
 *  dot product is already in range. */
export function cosine(a: Vector, b: Vector): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot < -1 ? -1 : dot > 1 ? 1 : dot;
}

function normalize(v: Vector): Vector {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n);
  return n > 0 ? v.map((x) => x / n) : v;
}

/** Fixed, consistent text shape so entries + contributions are comparable. */
export function embedInput(parts: {
  title?: string;
  summary?: string;
  detail?: string;
}): string {
  // TODO(tuning): nomic-embed-text is trained with task prefixes
  // ("search_document:" / "search_query:") and quality drops without them.
  // Our comparison is document-vs-document (entry vs contribution), so prefix
  // both with "search_document: " here to widen the related/unrelated cosine
  // gap (measured 0.62 vs 0.38 unprefixed on the live box). Must re-embed the
  // whole cache when changing this (it alters the vectors).
  return [parts.title, parts.summary, parts.detail]
    .filter(Boolean)
    .join("\n")
    .slice(0, 4000);
}

// ── Ollama-backed, hash-cached embedder ──────────────────────────────────────

interface CacheMeta {
  model: string;
  dim: number;
  updated: string;
}

export function createEmbedder(
  roots: KbRoots,
  config: EmbedConfig = resolveEmbedConfig()
): Embedder {
  const dir = vectorsDir(roots);
  const metaPath = join(dir, "meta.json");
  const cachePath = join(dir, "cache.jsonl");
  mkdirSync(dir, { recursive: true });

  // Load cache — but only if it was built with the SAME model. Mixing vectors
  // across models makes cosine meaningless, so a model change = full rebuild.
  const cache = new Map<string, Vector>();
  let meta: CacheMeta | null = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf-8")) as CacheMeta)
    : null;

  if (meta && meta.model !== config.model) {
    if (existsSync(cachePath)) rmSync(cachePath);
    meta = null;
  } else if (existsSync(cachePath)) {
    for (const line of readFileSync(cachePath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const { hash, vec } = JSON.parse(line) as { hash: string; vec: Vector };
      cache.set(hash, vec);
    }
  }

  async function callOllama(text: string): Promise<Vector> {
    const res = await fetch(`${config.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.model, prompt: text }),
    });
    if (!res.ok) {
      throw new Error(
        `Ollama embeddings failed (${res.status}): ${await res.text()}`
      );
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!json.embedding || json.embedding.length === 0) {
      throw new Error("Ollama returned no embedding — is the model pulled?");
    }
    return normalize(json.embedding);
  }

  return {
    async embed(text: string, hash: string): Promise<Vector> {
      const cached = cache.get(hash);
      if (cached) return cached;

      const vec = await callOllama(text);
      cache.set(hash, vec);

      // Persist incrementally (append the vector) + keep meta current.
      appendFileSync(cachePath, JSON.stringify({ hash, vec }) + "\n");
      meta = { model: config.model, dim: vec.length, updated: now() };
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      return vec;
    },
  };
}

// ── entry-vector index (for routing) ─────────────────────────────────────────

export interface EntryVector {
  entryId: string;
  canonicalId: string;
  domain: string;
  vector: Vector;
}

/**
 * Build the entry-vector index Dewey routes against. Scans every curated entry
 * in kb-base, embeds a consistent text shape (cached by hash), and tags each
 * with its canonical topic from the registry.
 */
export async function buildEntryVectors(
  roots: KbRoots,
  reg: Registry,
  embedder: Embedder
): Promise<EntryVector[]> {
  const { readdirSync } = await import("node:fs");
  const domainsRoot = join(roots.kbBase, "domains");
  if (!existsSync(domainsRoot)) return [];

  // entryId → canonicalId lookup from the registry.
  const canonicalOf = new Map<string, string>();
  for (const topic of reg.values()) {
    for (const id of topic.entries) canonicalOf.set(id, topic.canonicalId);
  }

  const out: EntryVector[] = [];
  for (const domain of readdirSync(domainsRoot)) {
    const entriesDir = join(domainsRoot, domain, "entries");
    if (!existsSync(entriesDir)) continue;
    for (const file of readdirSync(entriesDir).filter((f) => f.endsWith(".md"))) {
      const { fields, body } = parseFrontmatter(
        readFileSync(join(entriesDir, file), "utf-8")
      );
      const id = String(fields.id ?? file.replace(/\.md$/, ""));
      const text = embedInput({ title: String(fields.title ?? ""), detail: body });
      const hash = contentHash(text);
      const vector = await embedder.embed(text, hash);
      out.push({
        entryId: id,
        canonicalId: canonicalOf.get(id) ?? "",
        domain: String(fields.domain ?? domain),
        vector,
      });
    }
  }
  return out;
}
