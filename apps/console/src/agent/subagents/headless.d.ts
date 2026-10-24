/**
 * Verification engines for sub-agents: demos use the app's own Electron
 * browser-service via puppeteer-core, with system Chrome as fallback.
 * SVGs use resvg (browser fallback); PDFs use pdfjs + Skia (no browser).
 * No extra Chromium is shipped or downloaded.
 *
 * Chrome fallback resolution: CHROME_PATH first, then common macOS,
 * Windows and Linux install paths. `available()` is a cheap executable
 * check; the helper must still prove it can launch/connect at job time.
 *
 * Test seam: `headlessOverride.current` replaces the whole API (tests inject
 * a fake; nothing here touches a real browser). Builders call `getHeadless()`.
 */
export interface DemoRunResult {
    /** console.error / console messages of type "error". */
    consoleErrors: string[];
    /** Uncaught exceptions (window.onerror / unhandled rejections). */
    pageErrors: string[];
    /** Network requests that failed (CDN scripts that didn't load, …). */
    failedRequests: string[];
    /** Value of the optional probe expression, when requested and successful. */
    probeResult?: unknown;
    /** True when nothing above recorded anything. */
    ok: boolean;
}
export interface RunDemoOptions {
    /** How long to let the page settle (animations, async CDN loads) — default 2s. */
    settleMs?: number;
    /** Optional JS expression evaluated in the page after settling; its value
     * is returned to the builder so it can assert on internal state. */
    probe?: string;
}
export interface RenderSvgOptions {
    /** Viewport size — defaults to the SVG's width/height attrs, else 900×700. */
    width?: number;
    height?: number;
}
export interface RenderPdfOptions {
    /** Render DPI — 72 is 100% zoom; the skill's guidance is 100/150/200. */
    dpi?: number;
}
export interface RenderedPdfPage {
    page: number;
    png: Buffer;
}
export interface HeadlessApi {
    /** True when a browser helper or Chrome is resolvable (cheap, no launch). */
    available(): boolean;
    /** Why not — for error messages. */
    unavailableReason(): string | null;
    /** Execute HTML in a browser, capture errors, optionally probe. */
    runDemo(html: string, opts?: RunDemoOptions): Promise<DemoRunResult>;
    /** Rasterize an SVG to a PNG buffer (for verify-by-looking). */
    renderSvg(svg: string, opts?: RenderSvgOptions): Promise<Buffer>;
    /** Render PDF pages to PNGs natively (pdfjs + Skia) for the pdf-reader. */
    renderPdfPages(pdfPath: string, pages: number[], opts?: RenderPdfOptions): Promise<RenderedPdfPage[]>;
}
/** Test seam — undefined in production. */
export declare const headlessOverride: {
    current?: HeadlessApi;
};
export declare function getHeadless(): HeadlessApi;
export declare function resolveChromeExecutablePath(): string | null;
/** Handshake line parser (pure; exported for tests). */
export declare function parseBrowserServiceLine(line: string): number | null;
/** Spawn env sanitizer (pure; exported for tests): the helper must run as a
 *  FULL Electron app — ELECTRON_RUN_AS_NODE must not leak — and must not
 *  inherit the dev-shell userData redirect. */
export declare function browserServiceSpawnEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
/** The helper binary: inside the packaged app the server runs under
 *  ELECTRON_RUN_AS_NODE so process.execPath IS the app binary; in dev
 *  (plain node) the electron package resolves to the dev binary path. */
export declare function browserServiceBinary(): string | null;
/** Canonicalize a raw Chrome screenshot for the model's eyes (2026-09-19 fix).
 *
 *  WHY: Chrome writes PNGs with a SPLIT IDAT stream (4KB chunks) — and
 *  Alibaba's vision decoder (behind OpenRouter's qwen3.8-flash, the
 *  visual-maker's look-model) rejected those outright during the
 *  2026-09-18/19 window: "The image format is illegal and cannot be opened",
 *  deterministically, at every size (50–800px) — while every single-IDAT
 *  form passed (a handcrafted 1×1, and sharp re-encodes). On a later re-test
 *  raw Chrome PNGs passed too (the upstream decoder was fixed or is flaky
 *  per backend), but the canonical form stays: PNG spec says the IDAT chunks
 *  are an arbitrary SPLIT of one zlib stream, so merging them is the more
 *  standard shape, byte-identical stream, zero re-encoding.
 *
 *  Pure Node on purpose (no sharp): historically the process already carried
 *  a native image lib via @huggingface/transformers' nested sharp + libvips,
 *  and importing the root sharp (Next's optional dependency) put a SECOND
 *  libvips into the process — macOS's ObjC runtime warns (duplicate
 *  GNotificationCenterDelegate, "mysterious crashes"). The transformers
 *  embedder died with wave 6 (2026-09-23) but the rule lives on: one native
 *  image lib per process; app code carries none. */
export declare function providerSafePng(png: Buffer): Buffer;
export declare const realHeadless: HeadlessApi;
//# sourceMappingURL=headless.d.ts.map