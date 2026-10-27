/**
 * Server entry for the graph's stored positions (/api/graph/positions).
 * GET returns the whole map; PUT commits a batch from the live physics
 * (a drag that annealed to rest, or a first layout): the batch is sanitized
 * and merged over what is stored — ids it doesn't mention are kept, they
 * belong to layers or domains that are currently hidden.
 */
import { mergePositions, sanitizePositions, type PositionMap } from "../core/graph-persistence.ts";
import { readGraphPositions, writeGraphPositions } from "../store/graph-positions.ts";

export function graphPositions(): PositionMap {
	return readGraphPositions();
}

/** Commit a raw PUT body; returns the sanitized batch that was applied
 *  (empty = nothing valid in the body, nothing written). */
export function commitGraphPositions(input: unknown): PositionMap {
	const batch = sanitizePositions(input);
	if (Object.keys(batch).length === 0) return {};
	writeGraphPositions(mergePositions(readGraphPositions(), batch));
	return batch;
}
