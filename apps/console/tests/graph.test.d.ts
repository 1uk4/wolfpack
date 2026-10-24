/**
 * Graph merger + trigger + derivation tests (vision §1, 2026-09-02 redesign;
 * events cleanup 2026-09-27).
 * The merger (core/graph.ts mergeFindings) is the pipeline's deterministic
 * apply stage: AUDITED VERDICTS in, ledger appends out — link-or-create
 * identity (the auditor's linkTo, never string matching) and the
 * idempotency guarantees. No events ledger: quiz outcomes and
 * understanding observations are no longer formalized in the graph.
 *
 * Ledger isolation: PATHS is fixed at import time, so the five data/graph
 * ledgers are backed up and cleared before the suite and restored after
 * (try/finally-shaped: the after() hook always runs, even on failure).
 * The chat fixtures are real ChatRecords in the chat store (created and
 * deleted by this suite) — the merger reads exactly what production reads.
 * The full LLM pipeline (extractor → auditor) is tested in
 * tests/extraction.test.ts with mock models.
 */
export {};
//# sourceMappingURL=graph.test.d.ts.map