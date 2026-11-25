/**
 * Frame files: self-contained HTML the wolf writes for the viewer's sandboxed frames. They live in a per-wolf frames
 * directory OUTSIDE any git checkout (`<wolf home>/frames`), created lazily. `readFrameFile` is the only reader and
 * refuses everything that is not a plain `.html` file inside that directory.
 */
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import { HttpError } from "./http-error.js";

export const FRAME_MAX_BYTES = 2 * 1024 * 1024;

/** The wolf's frames directory (not created). The visualizer writes frame files here. */
export function framesRoot(wolfHome: string): string {
  return join(wolfHome, "frames");
}

/** Why `rel` cannot be shown as a frame (bad path, missing, over 2 MB), or undefined when readFrameFile would serve it. */
export function frameProblem(wolfHome: string, rel: string): string | undefined {
  try {
    readFrameFile(wolfHome, rel);
    return undefined;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.code === "not_found" ? `No frame file "${rel}" in your frames dir (${framesRoot(wolfHome)}). Have the visualizer write it first.` : `Cannot show frame "${rel}": ${e.message}.`;
  }
}

/** The file's bytes, or an HttpError: 400 bad path / extension, 403 refused, 404 missing, 413 too large. */
export function readFrameFile(wolfHome: string, rel: string | null): Buffer {
  if (!rel || rel.includes("\0")) throw new HttpError("invalid_request", "path is required");
  if (isAbsolute(rel) || rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) throw new HttpError("invalid_request", "path must be relative");
  const segments = rel.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");
  if (segments.length === 0) throw new HttpError("invalid_request", "path is required");
  if (segments.includes("..")) throw new HttpError("invalid_request", "path must not contain ..");
  if (segments.some((s) => s.startsWith("."))) throw new HttpError("forbidden", "dotfiles are not served");
  if (!/\.html$/i.test(segments[segments.length - 1]!)) throw new HttpError("invalid_request", "only .html frame files are served");

  const root = framesRoot(wolfHome);
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync.native(root);
  let real: string;
  try {
    real = realpathSync.native(join(realRoot, ...segments));
  } catch {
    // Missing, or a dangling symlink: nothing to show.
    throw new HttpError("not_found", "no such frame file");
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new HttpError("forbidden", "path leaves the frames directory");
  const st = statSync(real);
  if (!st.isFile()) throw new HttpError("forbidden", "not a regular file");
  if (st.size > FRAME_MAX_BYTES) throw new HttpError("too_large", `frame file is over ${FRAME_MAX_BYTES} bytes`);
  return readFileSync(real);
}
