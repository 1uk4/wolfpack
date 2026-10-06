/**
 * @wolfpack/kb — shared knowledge-base management.
 *
 * Three surfaces (import the narrow ones directly to keep bundles honest):
 *   @wolfpack/kb/shared     — schemas, paths, hashing (both sides)
 *   @wolfpack/kb/client     — wolf side, deterministic file I/O only
 *   @wolfpack/kb/librarian  — Dewey side, the pipeline + oracles
 */
export * from "./shared/index.js";
