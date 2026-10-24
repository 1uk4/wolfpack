import type { ArtifactPartProps } from "@/src/core";
/**
 * Visual artifact card (W6 → ack protocol): the tool part's output is the
 * dispatch ack, so the tool-call box is the DispatchCard (live status via
 * the chat view's jobs feed). The SVG itself renders from the steer message
 * (sub-agent result delivery) via VisualOutputCard.
 *
 * The SVG is model-authored for the learner's own machine (their own teacher
 * wrote it, verified by looking) — dangerouslySetInnerHTML is acceptable
 * here, with a cheap hygiene pass (sanitizeSvg: strip <script> blocks, on*
 * handlers, and javascript:/data:text/html URLs) since it lands in the
 * app's DOM.
 */
/** Cheap SVG hygiene — not a full sanitizer, just removing the obvious exec vectors. */
export declare function sanitizeSvg(svg: string): string;
/** The svg root's DECLARED width in px, when there is one — the natural
 *  size the card displays at instead of stretching to full width (owner,
 *  2026-10-07). %, em, "auto", or a missing attribute → null (the caller
 *  falls back to full-width). Pure. */
export declare function svgNaturalWidth(svg: string): number | null;
export declare function VisualCard({ part }: ArtifactPartProps): any;
/** The figure itself — exported: the steer card renders the delivered artifact. */
export declare function VisualOutputCard({ output, messageId, initialInverted, }: {
    output: unknown;
    messageId?: string;
    initialInverted?: boolean;
}): any;
//# sourceMappingURL=visual-card.d.ts.map