import type { QuestionAnswerData } from "@/src/core";
/**
 * Static rendering of an answered question (tool part in `output-available`).
 *
 * Quiz answers are GRADED: ✓/✗ marks, the correct answers, and the
 * explanation. Ask answers are NOT graded — a plain record of what was said.
 * (The v1 bug this pins: ask answers must never get quiz grading UI.)
 * Explain answers are graded by the MODEL in its next reply, not by the
 * client — the card reveals his answer, the committed correct answer, and
 * the explanation, with NO verdict chips (owner ruling 2026-09-27).
 */
export declare function AnsweredCard({ answer, input }: {
    answer: QuestionAnswerData;
    input?: unknown;
}): any;
//# sourceMappingURL=answered-card.d.ts.map