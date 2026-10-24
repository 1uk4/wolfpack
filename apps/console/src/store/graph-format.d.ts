/**
 * The graph-family FORMAT STAMP (schema-versioning wave, owner 2026-10-10):
 * data/graph/format.json — one sidecar versioning the whole graph dir
 * family (the four JSONL ledgers, sources.json, render-settings.json).
 * JSONL ledgers can't carry inline stamps without per-line bloat, and the
 * JSON files share the family's fate, so the stamp lives beside them.
 * positions.json is rebuildable (owner ruling) and needs no protection.
 *
 * The contract:
 *  - LAZY v1: NO sidecar = v1 (the pre-stamp world stays valid forever);
 *    the first graph-family WRITE creates it. Reads never write.
 *  - Honest refusal (owner: refuse-honestly ruling): a sidecar stamped
 *    NEWER than this build (the downgrade scenario — user reverted the
 *    app) makes graph-family reads THROW. Read-modify-write stores must
 *    never rewrite what they don't understand; a ledger store must never
 *    silently skip lines it can't interpret as current-format data.
 *
 * Version constants: contracts/graph.ts CURRENT_GRAPH_FORMAT_VERSION.
 */
/** READ-SIDE GUARD: throws when the data dir was written by a NEWER build.
 *  Called by every graph-family read — never writes (the golden fixtures
 *  pin reads as byte-identical). */
export declare function assertGraphFormat(): void;
/** WRITE-SIDE STAMP: creates the sidecar on the first graph-family write
 *  (lazy); afterwards a no-op existence-wise. Callers keep their own mkdir. */
export declare function ensureGraphFormat(): void;
//# sourceMappingURL=graph-format.d.ts.map