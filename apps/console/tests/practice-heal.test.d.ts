/**
 * THE WEAK-MODEL ARGUMENT HEAL (owner, 2026-10-04 — the GLM practice-loop
 * incident): glm-5.3 sent `"mode": "\"recall\""` — a JSON-string-encoded
 * enum — on 19 consecutive `problem` calls; TypeBox's "must be equal to
 * constant" error never named the expected values, so the model re-emitted
 * the identical payload until the dev server was killed.
 *
 * These pins hold the heal that runs at pi's prepareArguments seam (BEFORE
 * validation): string values where the schema expects a literal union /
 * boolean / null / number / array are JSON.parse-d and kept when the
 * parsed value satisfies the schema. Well-formed args pass through
 * untouched (same reference); unhealable values stay for validation to
 * reject honestly — the END-TO-END pins drive pi-ai's own
 * validateToolArguments: the healed args pass where the raw ones threw.
 */
export {};
//# sourceMappingURL=practice-heal.test.d.ts.map