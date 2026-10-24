/**
 * Rename-shuffle fix tests (2026-09-23 fix wave): the live-rename label
 * path must be LABEL-ONLY — it can never build a new snapshot object,
 * because the [snapshot]-keyed data feed (renderer.setData) treats any
 * identity change as "the server spoke": the geometry rebuild makes the
 * last-fetched ledger authoritative and cancels any pending drag
 * commit, rewinding the graph whenever display had drifted.
 *
 * The pinned contracts here:
 *   - renameSessionsPatch changes display state IN PLACE (no identity
 *     change → the data feed cannot re-fire);
 *   - seedMissingNodePositions gives ledger-unknown nodes a seeded ring
 *     instead of the old ?? 0 origin dump;
 *   - applyClusterLabels (the renderer's label-only channel) has its own
 *     suite in graph-canvas.test.ts.
 */
export {};
//# sourceMappingURL=graph-rename-labels.test.d.ts.map