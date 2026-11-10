/**
 * Observer — extract observations from a conversation chunk.
 * Agent-agnostic: takes an Engine and chunk text, returns observations.
 */
import type { Engine } from "@wolfpack/engine";
import { OBSERVER_SYSTEM, OBSERVER_GENERAL_FLAG, CRAWL_OBSERVER_SYSTEM } from "@wolfpack/engine";
import { buildObserverPrompt, buildCrawlObserverPrompt } from "./prompts.js";
import { ObserverResultSchema, ObserverResultWithGeneralSchema, type RawObservation } from "./schemas.js";

export interface ObserveOptions {
  /** The engine instance */
  engine: Engine;
  /** The conversation chunk (or document) text */
  chunkText: string;
  /** "conversation" (default, live memory) or "document" (crawl ingestion). */
  mode?: "conversation" | "document";
  /** Document mode only: the recovered source date for default timestamps. */
  sourceDate?: string;
  /** Domain context block for per-observation classification. */
  domainContext?: string;
  /** `memory.generalToDen`: ask the model for a `general` flag (conversation mode). Off: prompt and schema match the base. */
  generalFlag?: boolean;
}

export interface ObserveResult {
  observations: RawObservation[];
}

/**
 * Extract observations from a single conversation chunk.
 * One LLM call with Zod validation.
 */
export async function observe(options: ObserveOptions): Promise<ObserveResult> {
  const { engine, chunkText, mode = "conversation", sourceDate, domainContext, generalFlag } = options;

  let system = mode === "document" ? CRAWL_OBSERVER_SYSTEM : OBSERVER_SYSTEM;
  const withGeneral = generalFlag === true && mode !== "document";
  if (withGeneral) {
    system = system.replace("\n\nPreserve user assertions exactly:", `\n\n${OBSERVER_GENERAL_FLAG}\n\nPreserve user assertions exactly:`);
  }
  if (domainContext) {
    system += `\n\n## Domain Classification\n\nClassify each observation into exactly one domain. Set the "domain" field.\n\n${domainContext}`;
  }

  const prompt =
    mode === "document"
      ? buildCrawlObserverPrompt(chunkText, sourceDate)
      : buildObserverPrompt(chunkText);

  const result = await engine.call("classify", withGeneral ? ObserverResultWithGeneralSchema : ObserverResultSchema, {
    system,
    prompt,
  });

  return { observations: result.observations };
}

