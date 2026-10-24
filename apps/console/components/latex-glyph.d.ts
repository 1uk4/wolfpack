/** The raw katex HTML for a LaTeX command (pure, sync — SSR-safe). */
export declare function latexGlyphHtml(cmd: string): string;
/** One rendered LaTeX glyph. `cmd` is the LaTeX command ("\land",
 *  "\implies"); the output is aria-hidden — callers carry the textual
 *  aria-label (formatChainLine keeps the plain-text form). */
export declare function LatexGlyph({ cmd, testid, className, }: {
    cmd: string;
    testid?: string;
    className?: string;
}): any;
//# sourceMappingURL=latex-glyph.d.ts.map