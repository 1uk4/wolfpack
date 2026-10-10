/**
 * Observer prompts — extracted from OM, agent-agnostic.
 * System prompts (OBSERVER_SYSTEM, CRAWL_OBSERVER_SYSTEM) live in @wolfpack/engine.
 * This file provides the dynamic prompt builders for live and document modes.
 */

import {
  LIVE_OBSERVER_USER_PROMPT,
  CRAWL_OBSERVER_USER_PROMPT,
} from "../config/prompts/observations.js";
import { fillPromptTemplate } from "../config/prompts/template.js";

/**
 * Build the observation extraction prompt for a conversation chunk.
 * Uses OBSERVER_SYSTEM from @wolfpack/engine.
 */
export function buildObserverPrompt(chunkText: string): string {
  return fillPromptTemplate(LIVE_OBSERVER_USER_PROMPT, {
    currentLocalTime: new Date().toISOString().replace("T", " ").slice(0, 16),
    chunkText,
  });
}

/**
 * Build the document-mode extraction prompt. `sourceDate` is the recovered
 * document date (may be empty/undefined when undated).
 * Uses CRAWL_OBSERVER_SYSTEM from @wolfpack/engine.
 */
export function buildCrawlObserverPrompt(
  chunkText: string,
  sourceDate?: string
): string {
  return fillPromptTemplate(CRAWL_OBSERVER_USER_PROMPT, {
    sourceDate: sourceDate && sourceDate.trim() ? sourceDate : "(unknown — leave undated unless the text states a date)",
    chunkText,
  });
}
