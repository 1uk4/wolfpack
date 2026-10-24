/**
 * The UI parse seam — parse, don't cast (the rule born of the 2026-09-12
 * live crashes).
 *
 * WHY THIS EXISTS. Validation IS first at the model-facing boundary — pi
 * validates arguments against the tool's TypeBox schema before execute,
 * and the authoring refinements run in the execute seam; a failure
 * returns to the model as an error tool result, same turn. But the same bytes have two other consumers, and there they
 * exist UNVALIDATED BY DESIGN:
 *
 *   - the live wire streams raw tool-input deltas while the model is still
 *     typing the call (validation cannot run before the call is complete);
 *   - the transcript keeps the raw input of REJECTED calls too (transcript
 *     honesty + the replay invariant: every toolCall followed by a result).
 *
 * So invalid input is always observable, and part STATES carry the verdict
 * (input-streaming = partial, input-available = validated, output-error =
 * garbage). The flaw that made the crashes possible: consumers trusted
 * those shapes via TypeScript CASTS — `part.input as X` is a compile-time
 * lie the checker believes, with no runtime check behind it.
 *
 * THE RULE (mechanical, not vigilance): model-authored INPUT is consumed
 * only through these parsers, each running the SAME TypeBox schema the model
 * faced — boundary-valid ⇔ consumer-parseable, structurally. Server- and
 * learner-authored OUTPUT stays trusted (our own code authors it: the
 * execute acks, the learner's buildAnswer). A parse failure renders the
 * quiet fallback, never a crash.
 */
import { type AskToolInput, type QuizToolInput, type ExplainToolInput } from "./question-core.ts";
import { type ProbeDoneInput } from "./contracts/probe.ts";
export declare function parseQuizInput(input: unknown): QuizToolInput | undefined;
/**
 * Ask parse for DISPLAY: the full ask schema (options optional — free-text
 * mode is the options-less shape), plus the option-sanity refinement the
 * boundary enforced (askOptionProblems — duplicate values break the dock's
 * keying, so they parse to undefined exactly like the zod seam did).
 */
export declare function parseAskInput(input: unknown): AskToolInput | undefined;
/** Explain parse for DISPLAY: the display schema (base + OPTIONAL
 *  lenient `type`, exactly the quiz pattern — teach explain calls carry
 *  the role since 2026-10-09; the commitment refinement
 *  (explainInputProblems) mirrors the boundary chain). Both explain
 *  variants share the same fields; the teacher's nodeId is an unknown
 *  key Value.Clean strips, same as the quiz seam. */
export declare function parseExplainInput(input: unknown): ExplainToolInput | undefined;
/** probe_done parse — the core-owned schema the tool itself declares. */
export declare function parseProbeDoneInput(input: unknown): ProbeDoneInput | undefined;
//# sourceMappingURL=tool-parts.d.ts.map