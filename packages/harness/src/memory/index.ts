export { createMemoryExtension, type MemoryExtensionConfig } from "./extension.js";
export { consolidatePool, getPoolStats, type ConsolidationConfig, type ConsolidationResult } from "./consolidation.js";

// Re-export shared prompt context from @wolfpack/memory
export { renderDenContext, renderKbAccess } from "@wolfpack/memory";
