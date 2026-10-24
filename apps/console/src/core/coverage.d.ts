/**
 * Extraction coverage — the pure core. THE TEACHER'S PROSE IS THE UNIT
 * (owner ruling, 2026-09-28): the extractor sees ONLY the teacher agent's
 * text blocks — no learner messages, no thinking, no tool calls or
 * results, no quiz blocks. Everything else is INVISIBLE to coverage: it
 * neither opens nor joins a run, so answering a quiz or editing a learner
 * message triggers nothing. "Covered" is by construction exactly "what
 * the extractor saw": the fingerprint (sha256 of a message's view lines)
 * and the extractor's prompt share ONE selection — the teacher prose.
 *
 * A per-chat append-only ledger records which messages have been
 * extracted by CONTENT FINGERPRINT; "uncovered" is DERIVED at read time
 * (fingerprint the current transcript, diff against the ledger) — never
 * dual-tracked. Runs are token-budgeted batches of the oldest uncovered
 * teacher-prose messages: greedy consecutive fill, a message is never
 * split, a single over-budget message rides alone. (The old
 * inseparability bond — call + results in one chunk — died with the
 * ruling: tool results are invisible now, so nothing needs keeping
 * together.)
 */
import type { CoverageEntry } from "./contracts/graph.ts";
import type { LhMessage } from "./native-messages.ts";
export type { CoverageEntry };
/**
 * The extraction-relevant lines of ONE native message — the shared seam
 * between the extractor's prompt and messageFingerprint (coverage).
 * TEACHER PROSE ONLY (owner, 2026-09-28): an assistant message yields one
 * line per text block; everything else (user messages, tool results,
 * markers) yields NOTHING and is invisible to coverage. `mid` is the
 * message id — part of the hash input, so the same prose in two messages
 * is two slots (per-message coverage).
 */
export declare function messageViewLines(message: LhMessage, mid: string): string[];
/**
 * The teacher's prose blocks of a transcript, in order — the extractor's
 * prompt material. SAME selection as messageViewLines (the parity
 * doctrine survives the ruling in this one function pair), rendered
 * without the provenance prefix: plain paragraphs.
 */
export declare function teacherProseBlocks(messages: ReadonlyArray<LhMessage>): string[];
/** Tokens of a message's view — chars/4, ceil, the app-wide estimate. */
export declare function viewTokens(lines: string[]): number;
/**
 * A message's coverage fingerprint: sha256 of role + its view lines (the
 * teacher prose, with the message id as the tag). Changes exactly when
 * the teacher prose of the message changes — nothing else can re-open it.
 */
export declare function messageFingerprint(message: LhMessage): string;
/** One message's coverage-relevant projection. */
export interface CoverageSlot {
    message: LhMessage;
    fp: string;
    tokens: number;
}
/** Fingerprint a whole transcript, in order (used by the trigger, the run,
 *  and the coverage view — one derivation everywhere). */
export declare function coverageSlots(messages: ReadonlyArray<LhMessage>): CoverageSlot[];
/** The covered-fingerprint set for one chat, from the ledger. */
export declare function coveredSet(entries: ReadonlyArray<CoverageEntry>, chatId: string): Set<string>;
/** The derived state: which slots are uncovered, plus the token totals.
 *  "Uncovered" needs no ledger of its own — this diff IS the coverage view.
 *  `uncovered` is INDEXES into `slots` (the batcher batches by position).
 *  Messages with NO view lines — every learner message, every tool result,
 *  markers, prose-less assistant turns — are invisible to coverage
 *  entirely: the extractor can never see them, so they are neither covered
 *  nor uncovered. */
export declare function coverageOf(messages: ReadonlyArray<LhMessage>, entries: ReadonlyArray<CoverageEntry>, chatId: string): {
    slots: CoverageSlot[];
    uncovered: number[];
    coveredTokens: number;
    uncoveredTokens: number;
    coveredCount: number;
    uncoveredCount: number;
};
/**
 * Batch the uncovered teacher-prose messages into token-budgeted RUNS:
 * consecutive slots, oldest first, greedy fill — a message is never split.
 * A single message larger than the budget becomes its own (over-budget)
 * run rather than being dropped. Runs are ephemeral — the durable record
 * is per-message coverage, checkpointed after each run merges.
 */
export declare function batchRuns(slots: ReadonlyArray<CoverageSlot>, uncovered: ReadonlyArray<number>, budget: number): CoverageSlot[][];
/**
 * A batch's deterministic tag: hash of its member fingerprints. This is the
 * observation-ref prefix for the run (obs:<tag>:<sourceId> in the merger):
 * re-running the SAME batch (crash recovery) produces the same refs and
 * dedupes; a re-opened (mutated) message changes the tag, so its fresh
 * understanding observations land as new events — the most-recent fold
 * sees the update. Run-local source ids ("p1"…) alone could never do this:
 * their positions shift between runs.
 */
export declare function batchTag(batch: ReadonlyArray<CoverageSlot>): string;
//# sourceMappingURL=coverage.d.ts.map