"use client";

/**
 * The expanded bar's input half (composer, draft, attachments, send): loaded lazily by chat-bar.tsx so the layout only
 * ships the provider and the chip eagerly. It is mounted ONLY while the bar is open and not on the attached thread's own
 * page, so the draft hook never runs beside the page composer (their stale flushes would overwrite each other); on every
 * mount it re-reads the draft, so text typed on the page shows up here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AttachmentChips, Composer } from "@/components/composer";
import { useAttachedThread } from "@/components/attached-thread";
import { cardTextUrl, threadBase } from "@/components/thread-transport";
import { fitImageWithTimeout, browserFitDeps } from "@/components/image-fit";
import { canSendWith, chipFor, FALLBACK_LIMIT, fetchAttachmentLimit, fitFailureMessage, friendlyUploadError, readyInfos, uploadFile, UploadError, type AttachmentLimit, type PendingAttachment } from "@/components/attachments";
import { DictationBar, joinDictation, type Dictation } from "@/components/dictation";
import { useComposerDraft } from "@/lib/composer-draft";
import { abortThread, submitToThread } from "@/components/chat-bar-io";
import { bindingForAction, formatBinding, type AttachedRef } from "@/src/core";

import { ReplyingChip } from "@/components/replying-chip";
import { mergeRestored } from "@/components/composer-restore";

/**
 * `dictation` is owned by ChatBar (it must outlive this component: the composer unmounts when the bar is minimized or the
 * phone is on a thread page, and a run keeps going while the owner browses). This component only shows its meter and
 * registers where the transcript lands while it is mounted; with no composer mounted ChatBar writes it to the draft store.
 */
export default function ChatBarComposer({ target, title, cardOpen = false, askOpen = false, answering, onClearAnswering, onBound, onReplied, dictation, registerAppend }: { target: AttachedRef; title: string; cardOpen?: boolean; askOpen?: boolean; answering?: { callId: string; qid: string; label: string } | null; onClearAnswering?: () => void; onBound?: () => void; onReplied?: () => void; dictation: Dictation; registerAppend: (fn: ((t: string) => void) | null) => void }) {
	const api = useAttachedThread()!;
	const { working } = api;
	// Attachments pending in the thread page's composer ride with the PAGE's next send, never this input's (Enter here sends text only).
	const waiting = api.pageAttachments?.threadId === target.threadId ? api.pageAttachments.count : 0;
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

	// The transcript lands in this input (and its draft) while the composer is mounted.
	useEffect(() => {
		const fn = (t: string) => onChange(joinDictation(textRef.current, t));
		registerAppend(fn);
		return () => registerAppend(null);
	}, [onChange, registerAppend]);

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
		if (answering && t === "") return; // an attachment alone never answers a question
		if (answering) {
			// "Answering Qn": the text is that question's answer (a draft), not a chat message; nothing is superseded.
			applyText("");
			schedule("");
			setError(null);
			try {
				const res = await fetch(cardTextUrl(target.wolf, target.slug, answering.callId, answering.qid), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
				if (res.ok) {
					onClearAnswering?.();
					onBound?.();
					return;
				}
				const b = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(b?.error ?? "Could not save the answer.");
			} catch {
				setError("Could not save the answer.");
			}
			const merged = mergeRestored(t, textRef.current);
			applyText(merged);
			schedule(merged);
			return;
		}
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
	}, [attachments, applyText, schedule, api, target, working, onReplied, answering, onClearAnswering, onBound]);
	const stop = useCallback(() => void abortThread(target), [target]);
	// Enter while dictating finishes the run, then sends the spoken text (as on the thread page); one send in flight.
	const sendRef = useRef(send);
	sendRef.current = send;
	const sendInFlight = useRef(false);
	const onSend = useCallback(() => {
		if (sendInFlight.current) return;
		if (!dictation.active) return void send();
		sendInFlight.current = true;
		void dictation.finish().then(() => sendRef.current()).finally(() => void (sendInFlight.current = false));
	}, [dictation, send]);

	return (
		<>
			{error && <p role="alert" className="px-3 pt-1 font-ui text-xs text-destructive">{error}</p>}
			{waiting > 0 && (
				<p data-testid="chat-bar-attachments-waiting" className="px-3 pt-1 font-ui text-xs text-muted-foreground">
					{waiting} attachment{waiting === 1 ? "" : "s"} waiting in the thread
				</p>
			)}
			{answering && <ReplyingChip label={answering.label} onClear={onClearAnswering} className="px-3 pt-1" />}
			{askOpen && !answering && text.trim() !== "" && <p data-testid="ask-replace-hint" className="px-3 pt-1 font-ui text-xs text-muted-foreground">Sending a message replaces the open questions.</p>}
			<Composer
				busy={working}
				{...(cardOpen && canSendWith(text, attachments) ? { sendLabel: "Reply instead" } : {})}
				value={text}
				onChange={onChange}
				onSend={onSend}
				onStop={stop}
				canSend={answering ? text.trim() !== "" || (dictation.active && !working) : canSendWith(text, attachments) || (dictation.active && !working)}
				onEscape={dictation.active ? dictation.cancel : answering ? onClearAnswering : undefined}
				attachDisabled={answering ? "Images can't be attached to an answer yet" : undefined}
				enterSends={dictation.active}
				inputRef={inputRef}
				placeholder={`Message ${title}…  (${formatBinding(bindingForAction("focus-chat-bar"))} to focus)`}
				onFiles={answering ? undefined : onFiles}
				onPickFiles={onFiles}
				chips={<AttachmentChips items={attachments} onRemove={(k) => setAttachments((prev) => prev.filter((a) => a.key !== k))} />}
			/>
			<div className="px-3 pb-2" data-testid="dictation-slot">
				<DictationBar dictation={dictation} />
			</div>
		</>
	);
}
