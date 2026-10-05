/**
 * @wolfpack/consolidator — wolf-level memory consolidation.
 *
 * Bridges OM session memory → wolf den → Librarian claims.
 */

export {
  consolidateSession,
  type ConsolidateOptions,
  type ConsolidateResult,
} from "./consolidate.js";

export {
  readSessionMemory,
  listSessions,
  type SessionTopic,
  type SessionMemory,
} from "./session-reader.js";

export {
  readDenTopics,
  readDenJourney,
  writeDenTopic,
  writeDenJourney,
  getConsolidatedSessions,
  ensureDenDirs,
  type DenTopic,
  type DenConfig,
} from "./den.js";

export { renderDenIndex } from "./den-index.js";

export {
  ConsolidationResultSchema,
  type ConsolidationResult,
  type TopicAction,
} from "./schemas.js";
