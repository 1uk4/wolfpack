/**
 * @wolfpack/kb/client — the wolf side. Deterministic file I/O ONLY.
 *
 * MUST NOT import ../librarian or @wolfpack/engine's LLM surface. This is the
 * structural guarantee that wolves carry no pipeline, no embeddings, no LLM.
 */
export { emitDelta, type EmitDeltaInput } from "./emitDelta.js";
export {
  resolveWorkItem,
  listWorkItems,
  commitWorkItem,
  deleteWorkItemFile,
  readWorkLedger,
  appendWorkLedger,
  loadWorkState,
  type ResolvedWorkItem,
} from "./work-store.js";
export {
  createWork,
  stageWork,
  assignWork,
  noteWork,
  linkWork,
  setCriteria,
  retitleWork,
  deleteWork,
  queryWork,
  getWorkTree,
  type CreateWorkInput,
  type CreateWorkResult,
  type DeleteWorkResult,
  type WorkQuery,
} from "./work-ops.js";
export {
  type WorkItem,
  type WorkId,
  type WolfId,
  type WorkEvent,
  type LinkRel,
  assertAdvanceable,
  STAGE_ORDER,
  foldWork,
  projectWork,
  parseWorkEvent,
  WorkId as WorkIdSchema,
  WolfId as WolfIdSchema,
} from "../schema/work.js";
