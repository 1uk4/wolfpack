import type { CompactionDetails } from "@/src/core";
/** What one divider carries: the marker's full model-facing content (the
 *  [SESSION HISTORY COMPACTED] header + the summary) and its details.
 *  The content is deliberately UNRENDERED (owner, release polish
 *  2026-10-06): the compaction summary is model-facing plumbing — anyone
 *  who wants to inspect it reads their provider logs. The dividers mark
 *  WHERE the cut landed and how big it was; nothing opens. */
export interface CompactionDividerData {
    content: string;
    details: CompactionDetails;
}
/** The moment divider (owner round 14): minimal centered small text where
 *  the user currently is — the retrying-message register (SystemLine's
 *  exact classes), NO horizontal rule. The transcript's quiet note that
 *  history was just summarized; the cut divider below carries the seam.
 *  Inert since release polish 2026-10-06 — plain text, no affordance. */
export declare function CompactionMomentDivider({ data: _data }: {
    data: CompactionDividerData;
}): any;
/** The cut divider (owner round 14): the LONGER divider at the actual
 *  compaction cut — the seam where verbatim history ends and the kept
 *  recent tail begins. Phase-divider's geometry (dotted rules + centered
 *  chip) so it reads as a transcript boundary, not a message. Inert
 *  since release polish 2026-10-06 — the token count stays, the summary
 *  is inspectable only in provider logs. */
export declare function CompactionCutDivider({ data }: {
    data: CompactionDividerData;
}): any;
//# sourceMappingURL=compaction-divider.d.ts.map