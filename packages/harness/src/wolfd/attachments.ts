/**
 * Attachment storage for uploads: `<den>/attachments/<threadId>/<id>.<ext>`.
 * - The upload route is type-agnostic but only images are accepted for now: mime allow-list, size cap, and a magic-byte
 *   sniff (a mislabelled file inlined into the history would make every later model call fail).
 * - At submit the referenced files are read back and inlined as pi-ai image parts, with the path added in text so
 *   tools (bash, read) can reach the same file.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ATTACHMENT_IMAGE_TYPES, ATTACHMENT_MAX_BYTES, type Attachment, type AttachmentRef } from "@wolfpack/protocol";

export class AttachmentError extends Error {}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT).map(([m, e]) => [e, m]));
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Does the content match the claimed image type? */
function sniff(mimeType: string, b: Uint8Array): boolean {
  const at = (i: number, s: string) => s.split("").every((c, k) => b[i + k] === c.charCodeAt(0));
  switch (mimeType) {
    case "image/png":
      return b.length > 8 && b[0] === 0x89 && at(1, "PNG");
    case "image/jpeg":
      return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif":
      return b.length > 6 && at(0, "GIF8");
    case "image/webp":
      return b.length > 12 && at(0, "RIFF") && at(8, "WEBP");
    default:
      return false;
  }
}

const threadDir = (den: string, threadId: string) => join(den, "attachments", ...threadId.split("/").filter((s) => s && s !== "." && s !== ".."));

export function storeAttachment(den: string, threadId: string, bytes: Uint8Array, mimeType: string, name?: string): Attachment {
  const mime = mimeType.split(";")[0].trim().toLowerCase();
  if (!mime) throw new AttachmentError("missing Content-Type: send the image's mime type");
  if (!(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(mime)) throw new AttachmentError(`unsupported attachment type ${mime}: images only (${ATTACHMENT_IMAGE_TYPES.join(", ")})`);
  if (bytes.length === 0) throw new AttachmentError("attachment is empty");
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw new AttachmentError(`attachment too large (limit ${ATTACHMENT_MAX_BYTES} bytes)`);
  if (!sniff(mime, bytes)) throw new AttachmentError(`attachment content is not a valid ${mime}`);
  const id = randomUUID();
  const dir = threadDir(den, threadId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.${EXT[mime]}`), bytes);
  return { id, name: name ? basename(name).slice(0, 200) || `${id}.${EXT[mime]}` : `${id}.${EXT[mime]}`, mimeType: mime, size: bytes.length };
}

/** Resolve a ref to its stored file. Throws AttachmentError for a malformed or unknown id. */
export function loadAttachment(den: string, threadId: string, id: string): { path: string; mimeType: string; bytes: Buffer } {
  if (!ID_RE.test(id)) throw new AttachmentError(`unknown attachment ${id}`);
  const dir = threadDir(den, threadId);
  for (const ext of Object.keys(MIME_BY_EXT)) {
    const path = join(dir, `${id}.${ext}`);
    if (existsSync(path)) return { path, mimeType: MIME_BY_EXT[ext], bytes: readFileSync(path) };
  }
  throw new AttachmentError(`unknown attachment ${id}`);
}

/**
 * The attachments a user message was sent with, recovered from its `[Attached image: <path>]` lines (history is
 * rebuilt from engine entries, which only carry the text). Only paths inside THIS thread's attachment directory whose
 * file still exists count, so a forged or stale line yields nothing. The original file name is not kept: `name` is the
 * stored file name.
 */
export function attachmentsInText(den: string, threadId: string, text: string): Attachment[] {
  const dir = threadDir(den, threadId);
  const out: Attachment[] = [];
  for (const m of text.matchAll(/^\[Attached image: (.+)\]$/gm)) {
    const path = m[1];
    const file = basename(path);
    const dot = file.lastIndexOf(".");
    const id = file.slice(0, dot);
    const mimeType = MIME_BY_EXT[file.slice(dot + 1)];
    if (dot < 0 || !mimeType || !ID_RE.test(id) || path !== join(dir, file) || out.some((a) => a.id === id)) continue;
    try {
      out.push({ id, name: file, mimeType, size: statSync(path).size });
    } catch {
      /* file gone: skip */
    }
  }
  return out;
}

/**
 * THE CLEANUP SEAM. Thread deletion does not exist in wolfd yet; when it lands it must call this (exported from
 * `@wolfpack/harness/wolfd`) so the thread's uploads go with it. Removes `<den>/attachments/<threadId>/` recursively;
 * a no-op when the thread never had attachments. Nothing calls it today.
 */
export function removeThreadAttachments(den: string, threadId: string): void {
  rmSync(threadDir(den, threadId), { recursive: true, force: true });
}

/** Build the engine input: the text plus a path note per attachment, and one image part each. */
export function inlineAttachments(den: string, threadId: string, text: string, refs: readonly AttachmentRef[]) {
  const files = [...new Set(refs.map((r) => r.id))].map((id) => loadAttachment(den, threadId, id));
  const note = files.map((f) => `[Attached image: ${f.path}]`).join("\n");
  return [
    { type: "text" as const, text: text.trim() ? `${text}\n\n${note}` : note },
    ...files.map((f) => ({ type: "image" as const, data: f.bytes.toString("base64"), mimeType: f.mimeType })),
  ];
}
