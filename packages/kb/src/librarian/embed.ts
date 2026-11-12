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
  readdirSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite, parseFrontmatter, EMBED, SWEEP } from "@wolfpack/engine";
import { performance } from "node:perf_hooks";
import type { Timings } from "./timings.js";
import { listEntryFiles, readEntryCached } from "./entry-cache.js";
import { InfraError } from "./backoff.js";
import { createOnnxEmbedFn } from "./embed-onnx.js";
import { groupOf } from "./anchors.js";
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
  /** "ollama" (default) or "onnx": run the model in-process via onnxruntime-node (needs modelDir; no network). */
  provider?: "ollama" | "onnx";
  /** onnx only: directory holding tokenizer.json, tokenizer_config.json and the .onnx file (scripts/fetch-embed-model.mjs). */
  modelDir?: string;
  /** onnx only: onnxruntime intra-op threads (WOLFPACK_EMBED_THREADS). Unset = onnxruntime's own default. */
  threads?: number;
}

/**
 * Resolve config from env with lean local defaults. WOLFPACK_EMBED_PROVIDER=onnx + WOLFPACK_EMBED_MODEL_DIR selects the in-process embedder;
 * WOLFPACK_EMBED_THREADS (a positive integer) sets its onnxruntime intra-op threads, unset leaves onnxruntime's default.
 */
export function resolveEmbedConfig(): EmbedConfig {
  const threads = Number(process.env.WOLFPACK_EMBED_THREADS);
  const provider = process.env.WOLFPACK_EMBED_PROVIDER === "onnx" ? "onnx" : "ollama";
  return {
    baseUrl: process.env.WOLFPACK_EMBED_URL ?? EMBED.baseUrl,
    model: process.env.WOLFPACK_EMBED_MODEL ?? EMBED.model,
    provider,
    ...(process.env.WOLFPACK_EMBED_MODEL_DIR ? { modelDir: process.env.WOLFPACK_EMBED_MODEL_DIR } : {}),
    ...(Number.isInteger(threads) && threads > 0 ? { threads } : {}),
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

/** Version of the embedded text scheme (see embedInput). Stored in the cache
 *  meta: bump it whenever embedInput changes what gets embedded, so the next
 *  tick throws the stale vectors away and re-embeds every entry. */
export const EMBED_INPUT_VERSION = 2;

/** nomic-embed-text is trained with task prefixes; other models get none. */
export function isNomicModel(model: string): boolean {
  return /nomic/i.test(model);
}

/**
 * The text a vector is built from: title + summary ONLY (the detail dilutes
 * the subject; the 58-decision eval lifted top-1 from 59% to 87% with this).
 * Entries are "document"s and contributions "query"s; for a nomic model they
 * get the matching `search_document: ` / `search_query: ` prefix (eval config
 * C3), for any other model no prefix. `model` defaults to the configured one.
 */
export function embedInput(parts: {
  title?: string;
  summary?: string;
  role: "document" | "query";
  model?: string;
}): string {
  const model = parts.model ?? resolveEmbedConfig().model;
  const prefix = isNomicModel(model) ? `search_${parts.role}: ` : "";
  const text = [parts.title, parts.summary]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join("\n");
  return (prefix + text).slice(0, EMBED.inputMaxChars);
}

/**
 * An entry's summary for embedding and the subject check: the frontmatter
 * `summary` if set, else the lede — the first paragraph after the H1 (most
 * entries carry their summary there, not in frontmatter). The merge-band
 * eval measured title + lede.
 */
export function entrySummary(markdown: string): string {
  const { fields, body } = parseFrontmatter(markdown);
  const fm = String(fields.summary ?? "").trim();
  if (fm) return fm;
  // The lede: the first paragraph after the H1 that isn't a blockquote banner
  // (e.g. "> Dated snapshot…" notes sit above some ledes).
  const afterH1 = /^\s*#\s+[^\n]*\n+([\s\S]*)$/.exec(body)?.[1] ?? "";
  const lede = afterH1
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith(">") && !p.startsWith("#"));
  return (lede ?? "").slice(0, 600);
}

// ── Ollama-backed, hash-cached embedder ──────────────────────────────────────

interface CacheMeta {
  model: string;
  /** EMBED_INPUT_VERSION the vectors were built with (absent on old caches). */
  inputVersion?: number;
  dim: number;
  updated: string;
}

/** The embedder plus the cache upkeep the sweep tick runs. */
export interface CachedEmbedder extends Embedder {
  /** Rewrite the cache keeping only vectors whose hash is in `keep` (atomic).
   *  Returns how many vectors were dropped. */
  compact(keep: Set<string>): number;
  /** True when the cache file holds far more lines than `live` entries need. */
  shouldCompact(live: number): boolean;
}

/** Compact once the file holds this many times the live entries, plus slack. */
const COMPACT_RATIO = 2;
const COMPACT_SLACK = 50;

/** A parsed cache.jsonl kept across embedders in this process. It is valid while
 *  the file's mtime and size are unchanged (a writer in another process changes
 *  both); our own appends and compactions refresh it. */
interface LoadedCache {
  mtimeMs: number;
  size: number;
  model: string;
  vectors: Map<string, Vector>;
  /** Lines in the file, duplicates included. */
  lines: number;
}
const loadedCaches = new Map<string, LoadedCache>();

function statCache(path: string): { mtimeMs: number; size: number } | null {
  try {
    const st = statSync(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

export function createEmbedder(
  roots: KbRoots,
  config: EmbedConfig = resolveEmbedConfig()
): CachedEmbedder {
  const onnx = config.provider === "onnx";
  // ONNX vectors differ slightly from Ollama GGUF ones: never mix them in one cache.
  const cacheModel = onnx ? `${config.model}+onnx` : config.model;
  const dir = vectorsDir(roots);
  const metaPath = join(dir, "meta.json");
  const cachePath = join(dir, "cache.jsonl");
  mkdirSync(dir, { recursive: true });

  // Load cache — but only if it was built with the SAME model and embedded-text
  // scheme. Mixing vectors across either makes cosine meaningless, so a change
  // of model or EMBED_INPUT_VERSION = full rebuild.
  let meta: CacheMeta | null = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, "utf-8")) as CacheMeta)
    : null;

  if (meta && (meta.model !== cacheModel || meta.inputVersion !== EMBED_INPUT_VERSION)) {
    if (existsSync(cachePath)) rmSync(cachePath);
    loadedCaches.delete(cachePath);
    meta = null;
  }

  let loaded = loadedCaches.get(cachePath);
  const st = statCache(cachePath);
  if (!st) {
    loaded = undefined;
  } else if (!loaded || loaded.model !== cacheModel || loaded.mtimeMs !== st.mtimeMs || loaded.size !== st.size) {
    const vectors = new Map<string, Vector>();
    let lines = 0;
    for (const line of readFileSync(cachePath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const { hash, vec } = JSON.parse(line) as { hash: string; vec: Vector };
      vectors.set(hash, vec);
      lines++;
    }
    loaded = { ...st, model: cacheModel, vectors, lines };
  }
  const state: LoadedCache = loaded ?? { mtimeMs: 0, size: 0, model: cacheModel, vectors: new Map(), lines: 0 };
  loadedCaches.set(cachePath, state);
  const cache = state.vectors;

  /** Re-stamp the memo after we changed the file ourselves. */
  function refreshStamp(): void {
    const now = statCache(cachePath);
    if (now) Object.assign(state, now);
  }

  // Built once; a failure (missing files or packages) is kept too, so each embed doesn't retry the import.
  // A new embedder (new config) tries again.
  let onnxFn: Promise<(text: string) => Promise<number[]>> | undefined;
  async function callOnnx(text: string): Promise<Vector> {
    if (!config.modelDir) throw new InfraError("WOLFPACK_EMBED_PROVIDER=onnx needs WOLFPACK_EMBED_MODEL_DIR (run scripts/fetch-embed-model.mjs <dir>)");
    onnxFn ??= createOnnxEmbedFn({ modelDir: config.modelDir, ...(config.threads ? { threads: config.threads } : {}) });
    try {
      const fn = await onnxFn;
      return normalize(await fn(text));
    } catch (err) {
      throw err instanceof InfraError ? err : new InfraError(`ONNX embedder failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
  }

  async function callOllama(text: string): Promise<Vector> {
    let res: Response;
    try {
      res = await fetch(`${config.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: config.model, prompt: text, keep_alive: SWEEP.embedKeepAlive }),
        signal: AbortSignal.timeout(SWEEP.embedTimeoutMs),
      });
    } catch (err) {
      const why = err instanceof Error && err.name === "TimeoutError"
        ? `timed out after ${Math.round(SWEEP.embedTimeoutMs / 1000)}s`
        : `unreachable (${err instanceof Error ? err.message : String(err)})`;
      throw new InfraError(`Ollama ${why}`, { cause: err });
    }
    if (!res.ok) {
      const msg = `Ollama embeddings failed (${res.status}): ${await res.text()}`;
      // Server-side trouble or a missing model is not the contribution's fault.
      if (res.status >= 500 || [404, 408, 429].includes(res.status)) throw new InfraError(msg);
      throw new Error(msg);
    }
    const json = (await res.json()) as { embedding?: number[] };
    if (!json.embedding || json.embedding.length === 0) {
      throw new InfraError("Ollama returned no embedding — is the model pulled?");
    }
    return normalize(json.embedding);
  }

  return {
    async embed(text: string, hash: string): Promise<Vector> {
      const cached = cache.get(hash);
      if (cached) return cached;

      const vec = await (onnx ? callOnnx(text) : callOllama(text));
      cache.set(hash, vec);

      // Persist incrementally (append the vector) + keep meta current.
      appendFileSync(cachePath, JSON.stringify({ hash, vec }) + "\n");
      state.lines++;
      refreshStamp();
      meta = { model: cacheModel, inputVersion: EMBED_INPUT_VERSION, dim: vec.length, updated: now() };
      atomicWrite(metaPath, JSON.stringify(meta, null, 2));
      return vec;
    },

    compact(keep: Set<string>): number {
      const kept = [...cache].filter(([hash]) => keep.has(hash));
      const dropped = cache.size - kept.length;
      if (dropped === 0 && state.lines === cache.size) return 0;
      atomicWrite(cachePath, kept.map(([hash, vec]) => JSON.stringify({ hash, vec }) + "\n").join(""));
      cache.clear();
      for (const [hash, vec] of kept) cache.set(hash, vec);
      state.lines = kept.length;
      refreshStamp();
      return dropped;
    },

    shouldCompact(live: number): boolean {
      return state.lines > live * COMPACT_RATIO + COMPACT_SLACK;
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

interface ScannedEntry {
  id: string;
  domain: string;
  text: string;
  hash: string;
  /** Sits under another entry (frontmatter `group:`). */
  grouped: boolean;
}

const YIELD_EVERY = 25;
const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** Every curated entry in kb-base with the text its vector is cached under. */
function* scanEntries(roots: KbRoots, model: string): Generator<ScannedEntry> {
  const domainsRoot = join(roots.kbBase, "domains");
  if (!existsSync(domainsRoot)) return;
  for (const domain of readdirSync(domainsRoot)) {
    const entriesDir = join(domainsRoot, domain, "entries");
    if (!existsSync(entriesDir)) continue;
    for (const file of listEntryFiles(entriesDir)) {
      // A concurrent admin op (retire, split-fat) can delete an entry file
      // between this readdir snapshot and the readFileSync. Treat vanished
      // entries as benignly skipped — they are not in the registry anymore
      // either, so the vector set would exclude them on the next tick anyway.
      const cached = readEntryCached(join(entriesDir, file));
      if (!cached) continue;
      const fields = cached.fields;
      const text = embedInput({
        title: String(fields.title ?? ""),
        summary: cached.summary(),
        role: "document",
        model,
      });
      yield {
        id: String(fields.id ?? file.replace(/\.md$/, "")),
        domain: String(fields.domain ?? domain),
        text,
        hash: contentHash(text),
        grouped: !!cached.group(),
      };
    }
  }
}

/** Cache keys of the entries on disk now (no embedding): what a compaction keeps. */
export function currentEntryHashes(roots: KbRoots, model: string = resolveEmbedConfig().model): Set<string> {
  return new Set([...scanEntries(roots, model)].map((e) => e.hash));
}

/**
 * Build the entry-vector index Dewey routes against. Scans every curated entry
 * in kb-base, embeds a consistent text shape (cached by hash), and tags each
 * with its canonical topic from the registry.
 */
export async function buildEntryVectors(
  roots: KbRoots,
  reg: Registry,
  embedder: Embedder,
  model: string = resolveEmbedConfig().model,
  timings?: Timings
): Promise<EntryVector[]> {
  // entryId → canonicalId lookup from the registry.
  const canonicalOf = new Map<string, string>();
  for (const topic of reg.values()) {
    for (const id of topic.entries) canonicalOf.set(id, topic.canonicalId);
  }

  const out: EntryVector[] = [];
  const it = scanEntries(roots, model);
  let scanned = 0;
  for (;;) {
    // Let timers, /healthz and the watchdog ping run every 25 entries (the scan is read-only; no lock is held here).
    // A hub commit can land during this yield, so one scan may see a mix of old and new entries. That only affects placement
    // quality (the vectors are advisory), not correctness; a rebuild uses pause(), which waits for the tick to finish.
    if (scanned++ % YIELD_EVERY === YIELD_EVERY - 1) await yieldToLoop();
    const t0 = performance.now();
    const n = it.next();
    timings?.add("scan", performance.now() - t0);
    if (n.done) break;
    const e = n.value;
    // A grouped entry follows its holder's section: it takes no part in
    // similarity placement, so it is neither embedded nor vectored.
    if (e.grouped) continue;
    out.push({
      entryId: e.id,
      canonicalId: canonicalOf.get(e.id) ?? "",
      domain: e.domain,
      vector: await embedder.embed(e.text, e.hash),
    });
  }
  return out;
}
