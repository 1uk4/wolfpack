/**
 * Researcher PDF capability (PDF wave, 2026-10-07, design B): web_fetch_pdf
 * downloads a PDF into a per-job temp dir and returns the triage summary;
 * pdf_info/pdf_extract/pdf_search read it page-level, ALL scoped to the dir
 * (the researcher's filesystem ends at the temp wall). web_fetch gained the
 * PDF POINTER (no dead-end) and the Source line with final URL + HTTP
 * status (the "ill-formed request" lesson: 200-served error bodies must be
 * distinguishable from real pages).
 *
 * Zero network: globalThis.fetch is stubbed with a REAL minimal PDF built
 * programmatically (correct xref offsets — pdfjs parses it like any
 * download). Rendering is out of scope here (no vision in the researcher).
 */
export {};
//# sourceMappingURL=researcher-pdf.test.d.ts.map