/**
 * PDF plumbing for the pdf-reader sub-agent — sources v0 (2026-09): Node
 * ports of the four pdf-reader skill scripts (pdf_info / pdf_extract /
 * pdf_search / pdf_render), on the user-chosen hybrid stack:
 *
 * - TEXT (info / extract / search): pdfjs-dist — pure JS, no native deps.
 * - RENDER: subagents/headless.ts uses the same pdfjs engine with
 *   @napi-rs/canvas (Skia), in-process — no browser needed.
 *
 * Doctrine (the skill's reading strategy, mirrored in the sub-agent's system
 * prompt): triage with pdf_info FIRST, then size-based strategy — short PDFs
 * render all pages, medium render flagged (math/image-heavy) pages, long
 * ones search for targeted lookups before reading anything at length.
 *
 * These are pure library functions — no model in sight. The pdf-reader
 * agent (pdf-reader.ts) drives them through its own tool loop.
 */
export interface PdfPageInfo {
    page: number;
    text_length: number;
    image_count: number;
    /** Fraction of math-flavored chars — the render-this-page signal (port
     *  of the skill's unicode-range density heuristic). */
    math_density: number;
}
export interface PdfInfo {
    path: string;
    page_count: number;
    /** Mean chars/page — the size class the strategy branches on. */
    mean_text_length: number;
    pages: PdfPageInfo[];
}
/** Standard-font data dir (live-smoke finding 2026-09-19: without it pdfjs
 *  warns and falls back on non-embedded standard fonts — Helvetica, Times…).
 *  The node side takes a plain filesystem path, shared by text and rendering.
 *  pdfjs checks endsWith("/") even on Windows: use a literal trailing slash,
 *  NOT path.sep ("\\" on Windows). Node fs accepts this path on every OS. */
export declare function standardFontsDir(): string;
/** Cheap validity probe: getDocument resolves only for parseable PDFs —
 *  no page walk, no text extraction (unlike pdfInfo). The reader's upfront
 *  unreadable-source gate; garbage files throw pdfjs's precise error. */
export declare function pdfProbe(filePath: string): Promise<void>;
/** pdf_info: page count + per-page triage signals. ALWAYS run first. */
export declare function pdfInfo(filePath: string): Promise<PdfInfo>;
/** Parse 'all' | '1-5' | '1,3,7' | '3' into a sorted 1-indexed page list. */
export declare function parsePageSpec(spec: string, total: number): number[];
/** pdf_extract: text of the requested pages, `--- Page N ---` headed. */
export declare function pdfExtract(filePath: string, pageSpec: string): Promise<string>;
export interface PdfSearchHit {
    page: number;
    line: number;
    /** contextLines around the hit, `>>>` marking the hit line. */
    context: string;
}
/** pdf_search: keyword/regex across all pages with context lines.
 *  pageTexts rides along so the agent can extract a hit's full page without
 *  a second pass (the skill pipelines `search → extract` the same way). */
export declare function pdfSearch(filePath: string, query: string, opts?: {
    contextLines?: number;
    literal?: boolean;
}): Promise<{
    hits: PdfSearchHit[];
    pageTexts: Map<number, string>;
}>;
/** Where rendered pages land (mirrors the skill's /tmp convention). */
export declare function renderDir(filePath: string): string;
//# sourceMappingURL=pdf-ops.d.ts.map