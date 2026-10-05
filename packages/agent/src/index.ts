/**
 * @wolfpack/agent — VPS management agent.
 *
 * HTTP API that runs on each host, managing wolf processes.
 * Listens on port 3141 (configurable via WOLFPACK_AGENT_PORT).
 * Authenticated via X-API-Key header.
 */

export { WolfManager } from "./wolf-manager.js";
export { authMiddleware } from "./auth.js";
export { wolvesRouter } from "./routes/wolves.js";
export { logsRouter } from "./routes/logs.js";
export { healthRouter } from "./routes/health.js";
export * from "./types.js";
