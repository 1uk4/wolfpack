/**
 * Shared contracts — the single source of truth every component codes against.
 *
 * Split by domain (src/core/contracts/): graph.ts (the graph rendering
 * data), chat.ts (session records + UI extension points), jobs.ts (the
 * async job protocol), models.ts.  Each domain file is
 * owned outright by its stream; schema changes to a domain you don't own go
 * through master. This barrel keeps every existing import path
 * ("@/src/core" and "./contracts.ts") unchanged.
 */

export * from "./contracts/graph.ts";
export * from "./contracts/chat.ts";
export * from "./contracts/jobs.ts";
export * from "./contracts/models.ts";
