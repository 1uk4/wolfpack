/**
 * The extraction pipeline tests (vision §1 construction, 2026-09-02 redesign;
 * relinked 2026-09-27): extractor → auditor → merger, the sole graph writer —
 * the extractor alone sees the source (whole-session markdown), the auditor
 * never does (identity linking through graph tools), the merger is
 * deterministic.
 *
 *   transcriptView  — the markdown rendering the extractor sees (pure):
 *                     id-anchored Teacher/Learner blocks + check blocks
 *   pipeline        — scripted faux engines drive both agents: findings out,
 *                     audit verdict (with linkTo identity) in, deterministic
 *                     merge applied; failure paths checkpoint nothing;
 *                     single-flight per chat
 *
 * The merger itself (identity verdicts, idempotency) is tested in
 * tests/graph.test.ts directly against mergeFindings — here it is the
 * integration: what one full pipeline run does to the ledgers.
 *
 * Ledger: in-memory (the GraphStore port) — this suite never touches
 * data/graph. Chats: real ChatRecords in the real chat store (created and
 * deleted by this suite).
 */
export {};
//# sourceMappingURL=extraction.test.d.ts.map