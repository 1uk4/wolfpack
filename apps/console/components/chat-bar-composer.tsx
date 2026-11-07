"use client";

/**
 * The expanded bar's input half (composer, draft, attachments, send): loaded lazily by chat-bar.tsx so the layout only
 * ships the provider and the chip eagerly. It is mounted ONLY while the bar is open and not on the attached thread's own
 * page, so the draft hook never runs beside the page composer (their stale flushes would overwrite each other); on every
 * mount it re-reads the draft, so text typed on the page shows up here.
 */
import { useCallback, useRef, useState } from "react";
import { AttachmentChips, Composer } from "@/components/composer";
import { useAttachedThread } from "@/components/attached-thread";
import { threadBase } from "@/components/thread-transport";
import { fitImageWithTimeout, browserFitDeps } from "@/components/image-fit";
import { canSendWith, chipFor, FALLBACK_LIMIT, fetchAttachmentLimit, fitFailureMessage, friendlyUploadError, readyInfos, uploadFile, UploadError, type AttachmentLimit, type PendingAttachment } from "@/components/attachments";
import { useComposerDraft } from "@/lib/composer-draft";
import { abortThread, submitToThread } from "@/components/chat-bar-io";
import { bindingForAction, formatBinding, type AttachedRef } from "@/src/core";

/** The text to put back after a failed send: the sent text, then whatever was typed meanwhile (never dropped). */
export const mergeRestored = (sent: string, current: string): string => (current.trim() === "" ? sent : sent.trim() === "" ? current : `${sent}\n${current}`);

export default function ChatBarComposer({ target, title, cardOpen = false, onReplied }: { target: AttachedRef; title: string; cardOpen?: boolean; onReplied?: () => void }) {
	const api = useAttachedThread()!;
	const { working } = api;
	const [text, setText] = useState("");
	const textRef = useRef("");
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const [error, setError] = useState<string | null>(null);
	const applyText = useCallback((v: string) => {
		textRef.current = v;
		setText(v);
	}, []);
	const schedule = useComposerDraft(target.wolf, target.threadId, textRef, applyText);
	const onChange = useCallback((v: string) => {
		applyText(v);
		schedule(v);
	}, [applyText, schedule]);

	// Pasted / picked images upload exactly as on the thread page.
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const patch = useCallback((key: string, p: Partial<PendingAttachment>) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, ...p } : a))), []);
	const limitRef = useRef<AttachmentLimit | undefined>(undefined);
	const fitChain = useRef<Promise<unknown>>(Promise.resolve());
	const uploadUrl = `${threadBase(target.wolf, target.slug)}/attachments`;
	const onFiles = useCallback((files: File[]) => {
		for (const file of files) {
			const key = `att-${Math.random().toString(36).slice(2)}`;
			const { chip, upload } = chipFor(file, key, Infinity);
			setAttachments((prev) => [...prev, chip]);
			if (!upload) continue;
			const fit = fitChain.current.then(async () => {
				limitRef.current ??= await fetchAttachmentLimit();
				const limit = limitRef.current ?? FALLBACK_LIMIT;
				return { limit, result: await fitImageWithTimeout(file, limit.maxBytes, browserFitDeps()) };
			});
			fitChain.current = fit.catch(() => {});
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
	}, [uploadUrl, patch]);

	const send = useCallback(async () => {
		const t = textRef.current.trim();
		if (!canSendWith(t, attachments)) return;
		const refs = readyInfos(attachments);
		applyText("");
		schedule("");
		setAttachments((prev) => prev.filter((a) => a.status === "uploading"));
		setError(null);
		api.markSent();
		const ok = await submitToThread(target, t, working, refs);
		if (ok) onReplied?.(); // free text supersedes any open card (the wolf closes them as superseded)
		else {
			api.clearSent();
			setError("Could not send.");
			// Put the message back (merged with anything typed since) together with its attachments.
			const merged = mergeRestored(t, textRef.current);
			applyText(merged);
			schedule(merged);
			setAttachments((prev) => [...refs.map((r) => ({ key: `att-${r.id}`, name: r.name ?? "image", status: "ready" as const, id: r.id, mimeType: r.mimeType, size: r.size })), ...prev]);
		}
	}, [attachments, applyText, schedule, api, target, working, onReplied]);
	const stop = useCallback(() => void abortThread(target), [target]);

	return (
		<>
			{error && <p role="alert" className="px-3 pt-1 font-ui text-xs text-destructive">{error}</p>}
			<Composer
				busy={working}
				{...(cardOpen && canSendWith(text, attachments) ? { sendLabel: "Reply instead" } : {})}
				value={text}
				onChange={onChange}
				onSend={() => void send()}
				onStop={stop}
				canSend={canSendWith(text, attachments)}
				inputRef={inputRef}
				placeholder={`Message ${title}…  (${formatBinding(bindingForAction("focus-chat-bar"))} to focus)`}
				onFiles={onFiles}
				onPickFiles={onFiles}
				chips={<AttachmentChips items={attachments} onRemove={(k) => setAttachments((prev) => prev.filter((a) => a.key !== k))} />}
			/>
		</>
	);
}
