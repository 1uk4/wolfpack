/**
 * Composer attachments, the pure half: pull pasted/dropped/picked files out of
 * their sources, precheck them against the protocol limits, upload one to the
 * thread's attachment route, and decide what may be sent. Also the history
 * side: strip the model-facing path lines from a displayed user message and
 * hang the message's attachments on the native record.
 * The bytes go to the wolf (via the console's /api route) and never ride the
 * message: the send carries only `{id}` refs. Images only for now.
 */

import type { UiAttachment } from "@/src/core";
import { ATTACHMENT_IMAGE_TYPES, ATTACHMENT_MAX_BYTES, ATTACHMENT_NAME_HEADER } from "@wolfpack/protocol/attachments";

export interface PendingAttachment {
	/** Local key (stable across the upload). */
	key: string;
	name: string;
	status: "uploading" | "ready" | "error";
	/** The wolf's attachment id once uploaded. */
	id?: string;
	mimeType?: string;
	size?: number;
	error?: string;
}

/** What the UI knows about an attachment (a subset of the protocol's Attachment; refs on the wire carry only the id). */
export type AttachmentInfo = UiAttachment;

/** The client-side precheck (same limits as the wolf): the chip's error text, or undefined when the file may upload. */
export function precheckFile(file: { type: string; size: number }, maxBytes: number = ATTACHMENT_MAX_BYTES, relay = false): string | undefined {
	const mime = file.type.split(";")[0]!.trim().toLowerCase();
	if (!(ATTACHMENT_IMAGE_TYPES as readonly string[]).includes(mime)) {
		return `Unsupported type ${mime || "(unknown)"}: images only (${ATTACHMENT_IMAGE_TYPES.map((t) => t.slice(6)).join(", ")}).`;
	}
	if (file.size === 0) return "The file is empty.";
	if (file.size > maxBytes) return tooLargeMessage(maxBytes, relay, file.size);
	return undefined;
}

const mb = (n: number) => (n / 1024 / 1024).toFixed(1).replace(/\.0$/, "");

/** The composer's text for a file over the budget. */
export function tooLargeMessage(maxBytes: number, relay: boolean, size?: number): string {
	const got = size ? ` (${mb(size)} MB)` : "";
	return relay ? `Photo too large to send over the hub${got}, max ${mb(maxBytes)} MB.` : `Too large${got}; limit ${mb(maxBytes)} MB.`;
}

/** The hub's own wording for a body over its cap. */
const RELAY_TOO_LARGE = /too large for the relay/i;

/** A size refusal (a 413, the hub's "request body too large for the relay", the wolf's "attachment too large") as the friendly text; every other error (e.g. "header too large") passes through. */
export function friendlyUploadError(message: string, status: number | undefined, maxBytes: number, relay: boolean): string {
	return status === 413 || RELAY_TOO_LARGE.test(message) || /attachment too large/i.test(message) ? tooLargeMessage(maxBytes, relay) : message;
}

/** The chip text for each way fitting an image can fail. */
export function fitFailureMessage(reason: "too-large" | "gif-too-large" | "undecodable" | "unsupported", maxBytes: number, relay: boolean, size?: number): string {
	switch (reason) {
		case "undecodable":
			return "Couldn't read this image.";
		case "unsupported":
			return `Unsupported image type: ${ATTACHMENT_IMAGE_TYPES.map((t) => t.slice(6)).join(", ")} only.`;
		case "gif-too-large":
			return `This GIF is too large to send (${mb(maxBytes)} MB max) and can't be shrunk without losing the animation.`;
		default:
			return tooLargeMessage(maxBytes, relay, size);
	}
}

/** The chip for a file about to upload, or an error chip (nothing to upload) when the precheck refuses it. */
export function chipFor(file: File, key: string, maxBytes: number = ATTACHMENT_MAX_BYTES, relay = false): { chip: PendingAttachment; upload: boolean } {
	const name = file.name || "pasted image";
	const error = precheckFile(file, maxBytes, relay);
	return error ? { chip: { key, name, status: "error", error }, upload: false } : { chip: { key, name, status: "uploading", mimeType: file.type, size: file.size }, upload: true };
}

export interface AttachmentLimit {
	mode: "local" | "relay";
	maxBytes: number;
}

/** The budget used while the real one is unknown: relay mode's (1.8 MB), so a failed fetch can never let an oversize body through. */
export const FALLBACK_LIMIT: AttachmentLimit = { mode: "relay", maxBytes: Math.floor(2 * 1024 * 1024 * 0.9) };

/** The console's per-file budget (/api/attachment-limit), or undefined when it could not be read (callers use FALLBACK_LIMIT and must not cache the failure). */
export async function fetchAttachmentLimit(fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<AttachmentLimit | undefined> {
	try {
		const res = await fetchFn("/api/attachment-limit");
		if (!res.ok) return undefined;
		const j = (await res.json()) as Partial<AttachmentLimit>;
		if ((j.mode === "local" || j.mode === "relay") && typeof j.maxBytes === "number" && j.maxBytes > 0) return { mode: j.mode, maxBytes: j.maxBytes };
	} catch {
		/* unknown */
	}
	return undefined;
}

/** `accept` for the file picker input. */
export const PICKER_ACCEPT = ATTACHMENT_IMAGE_TYPES.join(",");

interface FileTransferLike {
	files?: ArrayLike<File> | null;
	types?: ArrayLike<string> | null;
}

/** Is a drag carrying files (so the composer should take the drop)? */
export const dragHasFiles = (dt: FileTransferLike | null | undefined): boolean => Array.from(dt?.types ?? []).includes("Files");

/** The files of a drop or a picker selection, all of them: non-images get an error chip from the precheck instead of vanishing. */
export const droppedFiles = (dt: FileTransferLike | null | undefined): File[] => Array.from(dt?.files ?? []);

interface ClipboardLike {
	items?: ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>;
}

/** The image files on a paste (screenshots arrive as `image/png` file items). */
export function pastedImages(data: ClipboardLike | null | undefined): File[] {
	const out: File[] = [];
	for (const item of Array.from(data?.items ?? [])) {
		if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
		const f = item.getAsFile();
		if (f) out.push(f);
	}
	return out;
}

export class UploadError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** POST the file's bytes to the thread's upload route; resolves with the wolf's attachment id. */
export async function uploadFile(
	uploadUrl: string,
	file: File,
	fetchFn: typeof fetch = (...a) => fetch(...a),
): Promise<{ id: string; name: string; mimeType: string; size: number }> {
	const headers: Record<string, string> = { "Content-Type": file.type || "application/octet-stream" };
	if (file.name) headers[ATTACHMENT_NAME_HEADER] = encodeURIComponent(file.name);
	const res = await fetchFn(uploadUrl, { method: "POST", headers, body: file });
	const text = await res.text();
	let body: { id?: unknown; name?: unknown; error?: unknown } = {};
	try {
		body = JSON.parse(text);
	} catch {
		/* non-JSON failure body */
	}
	if (!res.ok) throw new UploadError(typeof body.error === "string" ? body.error : text || `Upload failed (${res.status}).`, res.status);
	if (typeof body.id !== "string") throw new Error("Upload failed: unexpected response.");
	const b = body as { mimeType?: unknown; size?: unknown };
	return {
		id: body.id,
		name: typeof body.name === "string" ? body.name : file.name,
		mimeType: typeof b.mimeType === "string" ? b.mimeType : file.type,
		size: typeof b.size === "number" ? b.size : file.size,
	};
}

/** Refs of the finished uploads, in paste order. */
export const readyRefs = (list: readonly PendingAttachment[]): { id: string }[] =>
	list.flatMap((a) => (a.status === "ready" && a.id ? [{ id: a.id }] : []));

/** Send needs text or a finished attachment, and nothing still uploading. */
export const canSendWith = (text: string, list: readonly PendingAttachment[]): boolean =>
	!list.some((a) => a.status === "uploading") && (text.trim().length > 0 || readyRefs(list).length > 0);

/** The finished uploads as UI infos (for the optimistic bubble), in paste order. */
export const readyInfos = (list: readonly PendingAttachment[]): AttachmentInfo[] =>
	list.flatMap((a) => (a.status === "ready" && a.id ? [{ id: a.id, name: a.name, mimeType: a.mimeType, size: a.size }] : []));

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The text to DISPLAY for a user message that has attachments: the wolf appends `[Attached image: <path>]` lines for
 * the model (and its tools); the bubble shows thumbnails instead. Only the lines naming one of the message's resolved
 * attachments are removed (a line the user typed that names nothing real stays). The model-facing text is untouched.
 */
export function stripAttachmentLines(text: string, attachments: readonly { id: string }[]): string {
	if (attachments.length === 0) return text;
	const ids = attachments.map((a) => escapeRe(a.id)).join("|");
	const line = new RegExp(`^\\[Attached image: .*[\\\\/](?:${ids})\\.[a-z]+\\]$`);
	return text
		.split("\n")
		.filter((l) => !line.test(l))
		.join("\n")
		.replace(/\n+$/, "");
}

interface HistoryMessage {
	id: string;
	role: string;
	text: string;
	attachments?: AttachmentInfo[];
}

/**
 * History → native record, attachments: for each user message with `attachments`, the native message (matched by id)
 * gets the display text (path lines stripped) and the `attachments` the bubble renders thumbnails from. Everything
 * else is returned untouched, so it layers over `threadMessagesToNative` without touching it.
 */
export function withHistoryAttachments<T extends { id?: string; role?: string }>(native: readonly T[], history: readonly HistoryMessage[]): T[] {
	const byId = new Map(history.filter((m) => m.role === "user" && m.attachments?.length).map((m) => [m.id, m]));
	if (byId.size === 0) return [...native];
	return native.map((n) => {
		const h = n.role === "user" && n.id ? byId.get(n.id) : undefined;
		return h ? { ...n, content: stripAttachmentLines(h.text, h.attachments!), attachments: h.attachments } : n;
	});
}
