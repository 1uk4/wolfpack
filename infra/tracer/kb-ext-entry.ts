// Tracer --kb only: the REAL wolfpack-memory + tasks extension sources (same factories wolfd loads from <den>/extensions), bundled by the Dockerfile
// to /opt/wolfpack/kb-ext.mjs so stub-wolfd can install them with a scripted memory Engine (the established test seam: no LLM, no secrets).
export { default as createMemoryExtension } from "./extensions/wolfpack-memory/unified.js";
export { default as createTasksExtension } from "./extensions/wolfpack-memory/unified-tasks.js";
export { adaptToDurable } from "@wolfpack/harness";
