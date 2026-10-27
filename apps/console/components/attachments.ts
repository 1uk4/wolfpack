/**
 * Composer attachments, the pure half: pull pasted images out of a clipboard,
 * upload one to the thread's attachment route, and decide what may be sent.
 * The bytes go to the wolf (via the console's /api route) and never ride the
 * message: the send carries only `{id}` refs. Images only for now.
 */

import { ATTACHMENT_NAME_HEADER } from "@wolfpack/protocol/attachments";

export interface PendingAttachment {
	/** Local key (stable across the upload). */
	key: string;
	name: string;
	status: "uploading" | "ready" | "error";
	/** The wolf's attachment id once uploaded. */
	id?: string;
	error?: string;
}

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

/** POST the file's bytes to the thread's upload route; resolves with the wolf's attachment id. */
export async function uploadFile(uploadUrl: string, file: File, fetchFn: typeof fetch = (...a) => fetch(...a)): Promise<{ id: string; name: string }> {
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
	if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : text || `Upload failed (${res.status}).`);
	if (typeof body.id !== "string") throw new Error("Upload failed: unexpected response.");
	return { id: body.id, name: typeof body.name === "string" ? body.name : file.name };
}

/** Refs of the finished uploads, in paste order. */
export const readyRefs = (list: readonly PendingAttachment[]): { id: string }[] =>
	list.flatMap((a) => (a.status === "ready" && a.id ? [{ id: a.id }] : []));

/** Send needs text or a finished attachment, and nothing still uploading. */
export const canSendWith = (text: string, list: readonly PendingAttachment[]): boolean =>
	!list.some((a) => a.status === "uploading") && (text.trim().length > 0 || readyRefs(list).length > 0);
