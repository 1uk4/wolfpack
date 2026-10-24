import type { ArtifactPartProps } from "@/src/core";
/**
 * The research tool-call box (contracts.ts "THE ASYNC PROTOCOL" §4).
 *
 * The part's output is the fire-and-forget dispatch ACK — the box itself is
 * the DispatchCard (live status via the chat view's jobs feed; quiet one-liner
 * once delivered). The research brief itself no longer renders from the
 * tool part at all: it rides the steer message (the user-role delivery
 * injected after the wake turn) and renders there via ResearchBriefCard.
 */
export declare function JobCard({ part }: ArtifactPartProps): any;
/**
 * The pdf dispatch box (sources v0) — the same async-protocol idiom as
 * JobCard: the ack output drives a DispatchCard (live "PDF reader" status
 * via the chat view's jobs feed); the brief itself rides the steer message
 * and renders under the PDF-complete badge in the transcript.
 */
export declare function PdfJobCard({ part }: ArtifactPartProps): any;
/**
 * The PDF reading brief (sources v0) — markdown body + the consulted-pages
 * line. Exported: the steer card renders it under the PDF-complete badge,
 * the same expand-on-demand idiom as research.
 */
export declare function PdfBriefCard({ output }: {
    output: unknown;
}): any;
/**
 * The research brief — markdown body + a small source link list. Exported:
 * the steer card (sub-agent result delivery) renders the same artifact.
 */
export declare function ResearchBriefCard({ output }: {
    output: unknown;
}): any;
//# sourceMappingURL=job-card.d.ts.map