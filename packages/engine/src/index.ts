/**
 * @wolfpack/engine — the knowledge management engine.
 *
 * Schemas define every LLM call's contract.
 * Pipeline provides the pure-code functions.
 * Adapter is the pluggable LLM layer.
 */

// Schemas — the contracts
export * from "./schemas/index.js";

// Adapter — the LLM interface
export type { KnowledgeAdapter, ExtractOptions } from "./adapter.js";

// Pipeline — parse, search, commit, index
export * from "./pipeline/index.js";
