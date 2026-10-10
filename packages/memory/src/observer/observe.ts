/**
 * Observer — extract observations from a conversation chunk.
 * Agent-agnostic: takes an Engine and chunk text, returns observations.
 */
import type { Engine } from "@wolfpack/engine";
import { OBSERVER_SYSTEM, CRAWL_OBSERVER_SYSTEM } from "@wolfpack/engine";
import { buildObserverPrompt, buildCrawlObserverPrompt } from "./prompts.js";
import { ObserverResultSchema, type RawObservation } from "./schemas.js";

export interface ObserveOptions {
  /** The engine instance */
  engine: Engine;
  /** The conversation chunk (or document) text */
  chunkText: string;
  /** "conversation" (default, live memory) or "document" (crawl ingestion). */
  mode?: "conversation" | "document";
  /** Document mode only: the recovered source date for default timestamps. */
  sourceDate?: string;
}

export interface ObserveResult {
  observations: RawObservation[];
}

/**
 * Extract observations from a single conversation chunk.
 * One LLM call with Zod validation.
 */
export async function observe(options: ObserveOptions): Promise<ObserveResult> {
  const { engine, chunkText, mode = "conversation", sourceDate } = options;

  const system = mode === "document" ? CRAWL_OBSERVER_SYSTEM : OBSERVER_SYSTEM;
  const prompt =
    mode === "document"
      ? buildCrawlObserverPrompt(chunkText, sourceDate)
      : buildObserverPrompt(chunkText);

  const result = await engine.call("classify", ObserverResultSchema, {
    system,
    prompt,
  });

  return { observations: result.observations };
}

/**
 * Extract observations from multiple chunks in parallel.
 */
export async function observeParallel(
  engine: Engine,
  chunks: string[],
  concurrency: number = 4
): Promise<RawObservation[]> {
  const allObservations: RawObservation[] = [];
  const queue = [...chunks];
  const active: Promise<void>[] = [];

  while (queue.length > 0 || active.length > 0) {
    // Fill up to concurrency limit
    while (active.length < concurrency && queue.length > 0) {
      const chunk = queue.shift()!;
      const promise = observe({ engine, chunkText: chunk }).then((result) => {
        allObservations.push(...result.observations);
      });
      active.push(promise);
    }

    // Wait for one to complete
    if (active.length > 0) {
      await Promise.race(active);
      // Remove completed promises
      for (let i = active.length - 1; i >= 0; i--) {
        // Check if the promise is settled by racing with an instant resolve
        const settled = await Promise.race([
          active[i].then(() => true),
          Promise.resolve(false),
        ]);
        if (settled) active.splice(i, 1);
      }
    }
  }

  return allObservations;
}
