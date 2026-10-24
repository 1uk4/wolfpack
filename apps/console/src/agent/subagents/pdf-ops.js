import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
/** Load the legacy pdfjs build (runs headless in plain node, no worker). */
async function loadPdfjs() {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    return pdfjs;
}
/** Standard-font data dir (live-smoke finding 2026-09-19: without it pdfjs
 *  warns and falls back on non-embedded standard fonts — Helvetica, Times…).
 *  The node side takes a plain filesystem path, shared by text and rendering.
 *  pdfjs checks endsWith("/") even on Windows: use a literal trailing slash,
 *  NOT path.sep ("\\" on Windows). Node fs accepts this path on every OS. */
export function standardFontsDir() {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + "/";
}
async function openDocument(filePath) {
    const pdfjs = await loadPdfjs();
    const data = new Uint8Array(await fs.readFile(filePath));
    // The legacy build in plain node runs on a main-thread fake worker (no
    // workerSrc needed); teardown is the loading task's destroy().
    // verbosity 0 = errors only — scanned PDFs (JBIG2 XObjects) otherwise
    // flood the log with per-page warnings (live-smoke finding 2026-09-19).
    const task = pdfjs.getDocument({ data, standardFontDataUrl: standardFontsDir(), verbosity: 0 });
    return { doc: await task.promise, task };
}
/** Concatenate a page's text items into a body string. */
function itemsToText(items) {
    let out = "";
    for (const it of items) {
        if (it && typeof it === "object" && "str" in it) {
            const str = it.str;
            if (typeof str === "string")
                out += str;
        }
    }
    return out;
}
/** Math-flavored char fraction — the skill's heuristic, verbatim ranges. */
function mathDensity(text) {
    let mathChars = 0;
    for (const c of text) {
        const code = c.codePointAt(0);
        if ((code >= 0x2200 && code <= 0x22ff) || // Mathematical Operators
            (code >= 0x2100 && code <= 0x214f) || // Letterlike Symbols
            (code >= 0x2190 && code <= 0x21ff) || // Arrows
            (code >= 0x27c0 && code <= 0x27ef) || // Misc Mathematical Symbols-A
            (code >= 0x2980 && code <= 0x29ff) || // Misc Mathematical Symbols-B
            (code >= 0x2a00 && code <= 0x2aff) || // Supplemental Mathematical Operators
            (code >= 0x0370 && code <= 0x03ff) || // Greek
            (code >= 0x1d400 && code <= 0x1d7ff) || // Mathematical Alphanumeric Symbols
            "∫∑∏√∂∇∞≈≠≤≥±×÷∈∉⊂⊃∪∩∧∨¬∀∃∅".includes(c)) {
            mathChars++;
        }
    }
    return mathChars / Math.max(text.length, 1);
}
/** Cheap validity probe: getDocument resolves only for parseable PDFs —
 *  no page walk, no text extraction (unlike pdfInfo). The reader's upfront
 *  unreadable-source gate; garbage files throw pdfjs's precise error. */
export async function pdfProbe(filePath) {
    const { task } = await openDocument(filePath);
    await task.destroy();
}
/** pdf_info: page count + per-page triage signals. ALWAYS run first. */
export async function pdfInfo(filePath) {
    const pdfjs = await loadPdfjs(); // OPS constant for the operator-list scan
    const { doc } = await openDocument(filePath);
    const pages = [];
    let totalText = 0;
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = itemsToText(content.items);
        // count page images: paintImageXObject ops in the operator list
        const ops = await page.getOperatorList();
        let imageCount = 0;
        for (const fn of ops.fnArray) {
            if (fn === pdfjs.OPS.paintImageXObject)
                imageCount++;
        }
        totalText += text.length;
        pages.push({
            page: i,
            text_length: text.length,
            image_count: imageCount,
            math_density: Math.round(mathDensity(text) * 10000) / 10000,
        });
    }
    return {
        path: filePath,
        page_count: doc.numPages,
        mean_text_length: Math.round(totalText / Math.max(doc.numPages, 1)),
        pages,
    };
}
/** Parse 'all' | '1-5' | '1,3,7' | '3' into a sorted 1-indexed page list. */
export function parsePageSpec(spec, total) {
    const trimmed = spec.trim().toLowerCase();
    if (trimmed === "all")
        return Array.from({ length: total }, (_, i) => i + 1);
    const pages = new Set();
    for (const part of spec.split(",")) {
        const p = part.trim();
        if (!p)
            continue;
        if (p.includes("-")) {
            const [startRaw, endRaw] = p.split("-", 2);
            const start = Math.max(1, parseInt(startRaw, 10));
            const end = Math.min(total, parseInt(endRaw, 10));
            for (let pg = start; pg <= end; pg++)
                pages.add(pg);
        }
        else {
            const pg = parseInt(p, 10);
            if (pg >= 1 && pg <= total)
                pages.add(pg);
        }
    }
    return [...pages].sort((a, b) => a - b);
}
/** pdf_extract: text of the requested pages, `--- Page N ---` headed. */
export async function pdfExtract(filePath, pageSpec) {
    const { doc } = await openDocument(filePath);
    const pages = parsePageSpec(pageSpec, doc.numPages);
    if (pages.length === 0)
        return "No pages selected — page spec matched nothing.";
    const out = [];
    for (const i of pages) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        out.push(`--- Page ${i} ---`);
        out.push(itemsToText(content.items));
    }
    return out.join("\n");
}
/** pdf_search: keyword/regex across all pages with context lines.
 *  pageTexts rides along so the agent can extract a hit's full page without
 *  a second pass (the skill pipelines `search → extract` the same way). */
export async function pdfSearch(filePath, query, opts) {
    const contextLines = opts?.contextLines ?? 3;
    const { doc } = await openDocument(filePath);
    let pattern;
    if (opts?.literal) {
        pattern = new RegExp(escapeRegex(query), "i");
    }
    else {
        try {
            pattern = new RegExp(query, "i");
        }
        catch (err) {
            throw new Error(`Invalid regex: ${err.message}`);
        }
    }
    const hits = [];
    const pageTexts = new Map();
    for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const text = itemsToText(content.items);
        pageTexts.set(i, text);
        const lines = text.split("\n");
        for (let ln = 0; ln < lines.length; ln++) {
            if (!pattern.test(lines[ln]))
                continue;
            const start = Math.max(0, ln - contextLines);
            const end = Math.min(lines.length, ln + contextLines + 1);
            const context = lines
                .slice(start, end)
                .map((l, j) => `${start + j === ln ? ">>>" : "   "} ${l}`)
                .join("\n");
            hits.push({ page: i, line: ln + 1, context });
        }
    }
    return { hits, pageTexts };
}
function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Where rendered pages land (mirrors the skill's /tmp convention). */
export function renderDir(filePath) {
    // FNV-1a short hash of the absolute path — stable per file, no deps.
    const abs = path.resolve(filePath);
    let h = 0x811c9dc5;
    for (let i = 0; i < abs.length; i++) {
        h ^= abs.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return path.join("/tmp", `lh-pdf-${h.toString(16).padStart(8, "0")}`);
}
//# sourceMappingURL=pdf-ops.js.map