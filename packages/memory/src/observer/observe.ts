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

