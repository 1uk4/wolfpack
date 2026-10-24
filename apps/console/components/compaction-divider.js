"use client";
/** The moment divider (owner round 14): minimal centered small text where
 *  the user currently is — the retrying-message register (SystemLine's
 *  exact classes), NO horizontal rule. The transcript's quiet note that
 *  history was just summarized; the cut divider below carries the seam.
 *  Inert since release polish 2026-10-06 — plain text, no affordance. */
export function CompactionMomentDivider({ data: _data }) {
    return (<div className="flex w-full items-center justify-center py-1">
			<span data-testid="compaction-divider" className="px-1.5 text-xs text-muted-foreground/70">
				Context compacted
			</span>
		</div>);
}
/** The cut divider (owner round 14): the LONGER divider at the actual
 *  compaction cut — the seam where verbatim history ends and the kept
 *  recent tail begins. Phase-divider's geometry (dotted rules + centered
 *  chip) so it reads as a transcript boundary, not a message. Inert
 *  since release polish 2026-10-06 — the token count stays, the summary
 *  is inspectable only in provider logs. */
export function CompactionCutDivider({ data }) {
    const kTok = data.details.tokensBefore > 0 ? ` · ${Math.round(data.details.tokensBefore / 1000)}k tok` : "";
    return (<div data-testid="compaction-cut-divider" className="my-4 flex w-full items-center gap-3">
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden/>
			<span className="rounded-full border border-border/80 px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				History compacted{kTok}
			</span>
			<span className="h-0 flex-1 border-t-2 border-dotted border-border/50" aria-hidden/>
		</div>);
}
//# sourceMappingURL=compaction-divider.js.map