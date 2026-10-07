/**
 * config — the EDITABLE CONTROL SURFACE of the knowledge system.
 *
 * Three files, all typed, all meant to be tuned by hand as the system grows:
 *   · vocab.ts    — controlled vocabularies (what the LLM may categorize into)
 *   · tuning.ts   — numeric knobs (thresholds, weights, graph params)
 *   · ../prompts.ts — the LLM system prompts (how the LLM is asked to choose)
 *
 * Together these are the "what/how-much/how" of the system's behavior, kept out
 * of the logic so you can iterate on them directly.
 */
export * from "./vocab.js";
export * from "./tuning.js";
