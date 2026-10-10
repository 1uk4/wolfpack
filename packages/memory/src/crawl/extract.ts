/**
 * extract — the doc-mode observer stage. For each batch, read its files IN ORDER,
 * split into chunks, and run the document-mode observer (spec §7). Every
 * observation is dumped to the /tmp sink's observations.jsonl so extraction can be
 * watched before consolidation is wired. One LLM touchpoint, identical to live
 * memory's observer.
 */
import { readFileSync } from "node:fs";
import type { Engine } from "@wolfpack/engine";
import { observe } from "../observer/index.js";
import { ordersJourney } from "./dates.js";
import type { CrawlPlan, DatedFile } from "./schemas.js";
import type { CrawlSink } from "./sink.js";

/** One extracted observation with crawl provenance. */
export interface CrawlObservation {
  batch: string;
  relPath: string;
  /** The recovered source date for the file (empty when undated). */
  sourceDate: string;
  /** The observer's timestamp (source date, in-text date, or empty). */
  timestamp: string;
  content: string;
}

export interface ExtractOptions {
  /** ~chars per chunk (default 16k ≈ 4k tokens). */
  chunkChars?: number;
  /**
   * Per-file checkpoint, fired after each file in the batch is scanned. Lets a
   * monitor show fine-grained progress (files read, observations so far)
   * instead of one long opaque "extracting" step.
   */
  onFile?: (scanned: number, total: number, observations: number) => void;
  /** Cooperative cancellation: stop scanning further files/chunks when aborted. */
  signal?: AbortSignal;
}

/** Split text into deterministic chunks on paragraph boundaries near the limit. */
export function chunkText(text: string, maxChars = 16000): string[] {
  if (text.length <= maxChars) return text.length ? [text] : [];
  const chunks: string[] = [];
  const paras = text.split(/\n\n+/);
  let cur = "";
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > maxChars) {
      chunks.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + p;
    while (cur.length > maxChars) {
      chunks.push(cur.slice(0, maxChars));
      cur = cur.slice(maxChars);
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Extract observations for a single batch, in file order. Returns the
 * observations and also streams them to the sink.
 */
export async function extractBatch(
  engine: Engine,
  plan: CrawlPlan,
  batchTopic: string,
  files: DatedFile[],
  sink: CrawlSink,
  opts: ExtractOptions = {}
): Promise<CrawlObservation[]> {
  const out: CrawlObservation[] = [];
  let scanned = 0;
  for (const f of files) {
    if (opts.signal?.aborted) break;
    const sourceDate = ordersJourney(f.dateInfo) ? f.dateInfo.date ?? "" : "";
    let raw: string;
    try {
      raw = readFileSync(f.absPath, "utf-8");
    } catch (err) {
      sink.log(`extract: unreadable ${f.relPath} — ${String(err)}`);
      scanned++;
      opts.onFile?.(scanned, files.length, out.length);
      continue;
    }
    const chunks = chunkText(raw, opts.chunkChars);
    for (const chunk of chunks) {
      if (opts.signal?.aborted) break;
      const { observations } = await observe({
        engine,
        chunkText: chunk,
        mode: "document",
        sourceDate,
      });
      for (const o of observations) {
        const rec: CrawlObservation = {
          batch: batchTopic,
          relPath: f.relPath,
          sourceDate,
          timestamp: o.timestamp ?? "",
          content: o.content,
        };
        out.push(rec);
        sink.jsonl("observations.jsonl", rec);
      }
    }
    sink.log(`extract: ${batchTopic}/${f.relPath} — ${out.length} obs so far`);
    scanned++;
    opts.onFile?.(scanned, files.length, out.length);
  }
  return out;
}

