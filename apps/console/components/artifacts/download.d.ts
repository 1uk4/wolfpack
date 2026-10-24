/**
 * Artifact download helpers (release polish, 2026-10-07): the tiny
 * save-a-blob seam shared by the demo + figure cards, plus the filename
 * slug. The slug is pure (test-pinned); downloadFile touches the DOM and
 * only runs on click.
 */
/** Slugify a demo title into a filename stem — lowercase, accents folded,
 *  runs of non-alphanumerics collapsed to "-", trimmed, capped at 64
 *  chars. Empty/fully-symbolic titles fall back to "demo". */
export declare function slugFilename(title: string): string;
/** Save text as a downloaded file. The blob URL is revoked right after the
 *  click — Chromium keeps the download alive past the revoke. */
export declare function downloadFile(name: string, text: string, mime: string): void;
//# sourceMappingURL=download.d.ts.map