import { fitImageWithTimeout, browserFitDeps } from "@/components/composer/image-fit";
import { chipFor, FALLBACK_LIMIT, fetchAttachmentLimit, fitFailureMessage, friendlyUploadError, uploadFile, UploadError, type AttachmentLimit, type PendingAttachment } from "@/components/composer/attachments";

/** What a composer keeps between batches: the per-file budget (fetched once, a failure retried) and the fit queue. */
export interface UploadState {
	limit: { current: AttachmentLimit | undefined };
	chain: { current: Promise<unknown> };
}
export const newUploadState = (): UploadState => ({ limit: { current: undefined }, chain: { current: Promise.resolve() } });

/**
 * Pasted, dropped or picked images: each gets a chip at once (`add`), is fitted one at a time (decoding is memory-heavy on iOS), then
 * uploaded in parallel; `patch` marks the chip ready or failed. Shared by the page composer, the bar composer and the sheet's inline answer composer.
 */
export function startUploads(files: File[], uploadUrl: string, st: UploadState, add: (chip: PendingAttachment) => void, patch: (key: string, p: Partial<PendingAttachment>) => void): void {
	for (const file of files) {
		const key = `att-${Math.random().toString(36).slice(2)}`;
		// Infinity: the size is NOT prechecked here (type and emptiness only); an over-budget image is fitted below, and only a failed fit reports "too large".
		const { chip, upload } = chipFor(file, key, Infinity);
		add(chip);
		if (!upload) continue;
		const fit = st.chain.current.then(async () => {
			st.limit.current ??= await fetchAttachmentLimit();
			const limit = st.limit.current ?? FALLBACK_LIMIT;
			return { limit, result: await fitImageWithTimeout(file, limit.maxBytes, browserFitDeps()) };
		});
		st.chain.current = fit.catch(() => {});
		void (async () => {
			let limit = FALLBACK_LIMIT;
			try {
				const fitted = await fit;
				limit = fitted.limit;
				if (!fitted.result.ok) return patch(key, { status: "error", error: fitFailureMessage(fitted.result.reason, limit.maxBytes, limit.mode === "relay", file.size) });
				const { id, name, mimeType, size } = await uploadFile(uploadUrl, fitted.result.file);
				patch(key, { status: "ready", id, name, mimeType, size });
			} catch (err) {
				const e = err as Error;
				patch(key, { status: "error", error: friendlyUploadError(e.message, e instanceof UploadError ? e.status : undefined, limit.maxBytes, limit.mode === "relay") });
			}
		})();
	}
}
