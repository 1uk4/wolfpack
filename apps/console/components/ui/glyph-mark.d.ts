/**
 * GYpH-true ✓/✗ marks (owner's "old LaTeX style" round 6) — the real
 * Computer-Modern-adjacent hand-drawn shapes extracted as vector outlines
 * from the system Zapf Dingbats font (the exact font LaTeX pifont uses for
 * \ding{51} and \ding{55}), baked in as static SVG geometry (the KaTeX
 * pattern: glyph outlines are embedded, never rendered as font text).
 *
 * Bounds carry the ink box so each figure scales to its own geometry
 * (viewBox = minX -yMax w h with a y-flip on the path — SVG y grows
 * downward, font y grows upward).
 */
export type MarkKind = "check" | "x";
export declare function GlyphMark({ kind, className }: {
    kind: MarkKind;
    className?: string;
}): any;
//# sourceMappingURL=glyph-mark.d.ts.map