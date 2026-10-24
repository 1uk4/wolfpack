/**
 * GOLDEN FIXTURES (owner ruling, 2026-10-10): real user data, verbatim,
 * read through the PRODUCTION read paths. tests/fixtures/golden-data/ is a
 * real data dir (see its README); this suite copies it to a temp dir, points
 * the stores at it via the LH_DATA_DIR seam (set BEFORE any config-loading
 * import — every app-module import is dynamic), and asserts:
 *
 *   1. every record parses and passes the contract folds the app itself
 *      runs (phases, pending questions/problems, plan tree, summaries);
 *   2. the LLM wire flattening (toLlmMessages) turns each full record into
 *      a legal provider message list — the strongest property a record has;
 *   3. the graph derivation builds from the real ledgers end-to-end;
 *   4. marker COVERAGE: every custom-marker kind of the current contract
 *      appears in real data here (a new marker without a fixture update
 *      fails this suite);
 *   5. reads are READ-ONLY: after everything above, the copy is
 *      byte-identical to the fixture source.
 *
 * THE FIXTURE LAW: an intentional format change updates the fixtures in the
 * same commit; an unintentional one fails here.
 */
export {};
//# sourceMappingURL=golden-fixtures.test.d.ts.map