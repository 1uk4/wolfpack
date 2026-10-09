/**
 * @wolfpack/kb/client — the wolf side. Deterministic file I/O ONLY.
 *
 * MUST NOT import ../librarian or @wolfpack/engine's LLM surface. This is the
 * structural guarantee that wolves carry no pipeline, no embeddings, no LLM.
 */
export { emitDelta, type EmitDeltaInput } from "./emitDelta.js";
export { resolveEntry, listEntries, type ResolvedEntry } from "./resolve.js";
