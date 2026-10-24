/**
 * Server-side commit for the live physics drag (PUT /api/graph/positions).
 * The client's renderer anneals a drag to rest and PUTs the new rest
 * state; the server trusts it for the nodes it knows about and, if the
 * graph grew while the user was dragging (a merge landed), runs ONE
 * incremental settle (settleGraphLayout) so the fresh nodes are absorbed
 * into the frame the user just arranged — client positions act as
 * anchors, never as a clobber.
 *
 * Every body is sanitized: garbage coordinates clamp or drop, unknown
 * ids are discarded, nothing throws.
 *
 * KNOWN IDS = THE CANVAS'S WORLD (owner fix, 2026-10-06 — the splatter
 * bug): the derived view's nodes — stored propositions AND the derived
 * arg_ implication nodes. The canvas persists all of them; stripping
 * the args here purged their ledger entries on every drag-commit, so
 * each mount re-seeded them on a giant ring (the "splattered from the
 * middle" report) until a drag annealed them back. arg_ ids are stable
 * (minted from the chain ledger), so persisting them is sound.
 */
import type { Position } from "../core/contracts.ts";
/**
 * Accepts the raw PUT body (a Record of id → {x, y}) and returns the
 * sanitized positions actually persisted (empty object = nothing written,
 * e.g. a body with no known ids — the caller reports but never fails).
 */
export declare function commitPositions(input: unknown): Record<string, Position>;
//# sourceMappingURL=commit-positions.d.ts.map