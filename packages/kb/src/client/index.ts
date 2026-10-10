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
  unlinkWork,
  setCriteria,
  retitleWork,
  deleteWork,
  ensureInbox,
  moveWork,
  graduateWork,
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
  COMPLETE_STAGES,
  isComplete,
  BINDABLE_KINDS,
  isBindable,
  placementError,
  dependencyError,
  INBOX_TITLE,
  WORK_LINK_RELS,
  foldWork,
  projectWork,
  parseWorkEvent,
  WorkId as WorkIdSchema,
  WolfId as WolfIdSchema,
} from "../schema/work.js";
