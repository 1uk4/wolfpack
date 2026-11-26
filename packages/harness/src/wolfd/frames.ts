/**
 * Frame files: self-contained HTML the wolf writes for the viewer's sandboxed frames. They live in a per-wolf frames
 * directory OUTSIDE any git checkout (`<wolf home>/frames`), created lazily. `readFrameFile` is the only reader and
 * refuses everything that is not a plain `.html` file inside that directory. The path rules are protocol's
 * `framePathProblem` (one implementation, shared with the show_view schema).
 *
 * The writer of a frame may race the reader, so the read does not trust the earlier realpath/stat: it opens the file
 * with O_NOFOLLOW | O_NONBLOCK (a symlink or a FIFO swapped in cannot be followed or block), checks the OPEN descriptor
 * is a regular file at the same dev/ino, and reads at most the cap plus one byte.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { framePathProblem } from "@wolfpack/protocol";
import { HttpError } from "./http-error.js";

export const FRAME_MAX_BYTES = 2 * 1024 * 1024;

/** The wolf's frames directory (not created). The visualizer writes frame files here. */
export function framesRoot(wolfHome: string): string {
  return join(wolfHome, "frames");
}

/** Why a write of `bytes` to `rel` (relative to the frames dir) breaks the frame rules (.html only, no dotfiles, at most 2 MB), or undefined. The fence on the frames dir applies it to the visualizer's write and edit. */
export function frameWriteProblem(rel: string, bytes: number): string | undefined {
  const problem = framePathProblem(rel);
  if (problem) return `Refused: ${problem} (frame files are .html files in the frames dir).`;
  if (bytes > FRAME_MAX_BYTES) return `Refused: the file would be ${bytes} bytes, over the ${FRAME_MAX_BYTES}-byte frame limit. Make the page smaller.`;
  return undefined;
}

export interface FrameStat {
  /** The file's realpath, inside the frames dir. */
  path: string;
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
}

const errno = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code;

/** Why `rel` cannot be shown as a frame (bad path, missing, over 2 MB), or undefined when readFrameFile would serve it. Does not read the file. */
export async function frameProblem(wolfHome: string, rel: string): Promise<string | undefined> {
  try {
    await statFrame(wolfHome, rel);
    return undefined;
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return e.code === "not_found" ? `No frame file "${rel}" in your frames dir (${framesRoot(wolfHome)}). Have the visualizer write it first.` : `Cannot show frame "${rel}": ${e.message}.`;
  }
}

/** Validates `rel` and finds the file without reading it: HttpError 400 bad path / extension, 403 refused, 404 missing, 413 too large. */
export async function statFrame(wolfHome: string, rel: string | null): Promise<FrameStat> {
  if (!rel) throw new HttpError("invalid_request", "path is required");
  const problem = framePathProblem(rel);
  if (problem) throw new HttpError(problem.startsWith("dotfiles") ? "forbidden" : "invalid_request", problem);
  const segments = rel.split(/[\\/]+/).filter((s) => s !== "" && s !== ".");

  const root = framesRoot(wolfHome);
  await mkdir(root, { recursive: true });
  // (the root itself must be a real directory: `ln -s / frames` would serve the whole disk)
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new HttpError("forbidden", "the frames directory is not a plain directory");
  const realRoot = await realpath(root);
  if (realRoot === sep) throw new HttpError("forbidden", "the frames directory is the filesystem root");
  let real: string;
  try {
    real = await realpath(join(realRoot, ...segments));
  } catch (e) {
    // Missing (or a dangling symlink): nothing to show. Anything else (EACCES, ELOOP) is a refusal.
    throw errno(e) === "ENOENT" || errno(e) === "ENOTDIR" ? new HttpError("not_found", "no such frame file") : new HttpError("forbidden", "frame file cannot be resolved");
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new HttpError("forbidden", "path leaves the frames directory");
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(real);
  } catch (e) {
    throw errno(e) === "ENOENT" ? new HttpError("not_found", "no such frame file") : new HttpError("forbidden", "frame file cannot be read");
  }
  if (!st.isFile()) throw new HttpError("forbidden", "not a regular file");
  if (st.size > FRAME_MAX_BYTES) throw new HttpError("too_large", `frame file is over ${FRAME_MAX_BYTES} bytes`);
  return { path: real, size: st.size, dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
}

/** The file's bytes, or an HttpError: 400 bad path / extension, 403 refused, 404 missing, 413 too large. */
export async function readFrameFile(wolfHome: string, rel: string | null): Promise<Buffer> {
  const found = await statFrame(wolfHome, rel);
  let fh: Awaited<ReturnType<typeof open>>;
  try {
    fh = await open(found.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    throw errno(e) === "ENOENT" ? new HttpError("not_found", "no such frame file") : new HttpError("forbidden", "frame file cannot be opened");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.dev !== found.dev || st.ino !== found.ino) throw new HttpError("forbidden", "the frame file changed while it was read");
    // (one byte over the file's size at most, capped: a file that grew since the stat still reads to the cap plus one)
    const buf = Buffer.alloc(Math.min(st.size + 1, FRAME_MAX_BYTES + 1));
    let n = 0;
    while (n < buf.length) {
      const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
      if (bytesRead === 0) break;
      n += bytesRead;
    }
    if (n > FRAME_MAX_BYTES) throw new HttpError("too_large", `frame file is over ${FRAME_MAX_BYTES} bytes`);
    return buf.subarray(0, n);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError("forbidden", "frame file cannot be read");
  } finally {
    await fh.close().catch(() => undefined);
  }
}
