"use client";

/**
 * Answering one question of a paged `ask` from inside its sheet (work-wolfpack-ssPFrEw, work-wolfpack-fm2Ty06): the free-text or
 * Other field turns into a composer in place (paperclip, text area, Send, Dictate row; no model or Auto-ship controls). The host
 * hides its bottom composer meanwhile. Unsent text and queued images stay in `useInlineAnswers` per question, so closing the
 * composer (×, Esc, a click outside) loses nothing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AttachmentChips, Composer } from "@/components/composer";
import { ReplyingChip } from "@/components/replying-chip";
import { DictationBar, joinDictation, useDictationTarget, type Dictation } from "@/components/dictation";
import { postReply } from "@/components/ask-reply-send";
import { mergeRestored } from "@/components/composer-restore";
import { newUploadState, startUploads } from "@/components/attachment-upload";
import { canSendWith, readyInfos, type PendingAttachment } from "@/components/attachments";
import { threadBase } from "@/components/thread-transport";
import type { AttachedRef } from "@/src/core";

export interface InlineDraft {
	text: string;
	atts: PendingAttachment[];
}
const EMPTY: InlineDraft = { text: "", atts: [] };

/** Does a draft hold anything the owner has not sent? */
export const hasUnsent = (d: InlineDraft | undefined): boolean => !!d && (d.text.trim() !== "" || d.atts.length > 0);

/** The unsent drafts of a sheet's questions, with the upload and send logic that works on them. */
export function useInlineAnswers(target: Pick<AttachedRef, "wolf" | "slug">, onBound: () => void) {
	const [drafts, setDrafts] = useState<Record<string, InlineDraft>>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const ref = useRef(drafts);
	ref.current = drafts;
	const uploads = useRef(newUploadState());
	const inFlight = useRef(false);
	const update = useCallback((qid: string, fn: (d: InlineDraft) => InlineDraft) => setDrafts((all) => ({ ...all, [qid]: fn(all[qid] ?? EMPTY) })), []);
	const uploadUrl = `${threadBase(target.wolf, target.slug)}/attachments`;

	const setText = useCallback((qid: string, text: string) => update(qid, (d) => ({ ...d, text })), [update]);
	const addFiles = useCallback((qid: string, files: File[]) => {
		startUploads(files, uploadUrl, uploads.current, (chip) => update(qid, (d) => ({ ...d, atts: [...d.atts, chip] })), (key, p) => update(qid, (d) => ({ ...d, atts: d.atts.map((a) => (a.key === key ? { ...a, ...p } : a)) })));
	}, [uploadUrl, update]);
	const removeAtt = useCallback((qid: string, key: string) => update(qid, (d) => ({ ...d, atts: d.atts.filter((a) => a.key !== key) })), [update]);

	/** Bind the draft as the question's answer. Text and ready images leave the draft BEFORE the POST (a second Send finds nothing); a failure puts them back. Resolves the saved text ("" for images alone) or null when it failed. */
	const send = useCallback(async (callId: string, qid: string, multi?: (text: string) => { picked: string[]; others: string[] }): Promise<string | null> => {
		const cur = ref.current[qid] ?? EMPTY;
		const t = cur.text.trim();
		const refs = readyInfos(cur.atts);
		if ((t === "" && refs.length === 0) || inFlight.current) return null;
		inFlight.current = true;
		update(qid, (d) => ({ text: "", atts: d.atts.filter((a) => a.status === "uploading") }));
		setErrors(({ [qid]: _e, ...rest }) => rest);
		const err = await postReply(target.wolf, target.slug, callId, qid, t, refs.map((r) => r.id), multi?.(t));
		inFlight.current = false;
		if (!err) {
			setDrafts(({ [qid]: _d, ...rest }) => rest);
			onBound();
			return t;
		}
		setErrors((e) => ({ ...e, [qid]: err }));
		update(qid, (d) => ({ text: mergeRestored(t, d.text), atts: [...refs.map((r) => ({ key: `att-${r.id}`, name: r.name ?? "image", status: "ready" as const, id: r.id, mimeType: r.mimeType, size: r.size })), ...d.atts] }));
		return null;
	}, [target.wolf, target.slug, update, onBound]);
	return { drafts, errors, setText, addFiles, removeAtt, send };
}

/** The in-place composer: the "Replying to" header with ×, the shared Composer body without its controls, and the Dictate row. */
export function InlineAnswerComposer({ label, draft, error, dictation, onText, onFiles, onRemove, onSend, onClose }: {
	label: string;
	draft: InlineDraft;
	error?: string;
	dictation?: Dictation;
	onText: (v: string) => void;
	onFiles: (files: File[]) => void;
	onRemove: (key: string) => void;
	onSend: () => Promise<unknown> | void;
	onClose: () => void;
}) {
	const textRef = useRef(draft.text);
	textRef.current = draft.text;
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	// The transcript lands here while the composer is open (a persistent claim outranks the host's own composer).
	const append = useCallback((t: string) => onText(joinDictation(textRef.current, t)), [onText]);
	useDictationTarget(append, dictation !== undefined);
	useEffect(() => {
		const id = requestAnimationFrame(() => inputRef.current?.focus());
		return () => cancelAnimationFrame(id);
	}, []);
	// Enter while dictating finishes the run, then sends the spoken text; one send in flight.
	const sending = useRef(false);
	const sendRef = useRef(onSend);
	sendRef.current = onSend;
	const send = useCallback(() => {
		if (sending.current) return;
		if (!dictation?.active) return void sendRef.current();
		sending.current = true;
		void dictation.finish().then(() => sendRef.current()).finally(() => void (sending.current = false));
	}, [dictation]);
	const live = dictation?.active === true;
	return (
		<div data-testid="ask-inline-composer" className="overflow-hidden rounded-xl bg-background/60 transition-colors focus-within:bg-background/80">
			<ReplyingChip label={label} onClear={onClose} className="px-2 pt-1.5" />
			{error && <p role="alert" className="px-3 pt-1 font-ui text-xs text-destructive">{error}</p>}
			<Composer
				busy={false}
				value={draft.text}
				onChange={onText}
				onSend={send}
				onStop={() => {}}
				canSend={canSendWith(draft.text, draft.atts) || live}
				onEscape={live ? dictation!.cancel : onClose}
				enterSends={live}
				inputRef={inputRef}
				placeholder="Your answer…"
				onFiles={onFiles}
				onPickFiles={onFiles}
				chips={<AttachmentChips items={draft.atts} onRemove={onRemove} />}
			/>
			{dictation && (
				<div className="px-3 pb-2" data-testid="dictation-slot">
					<DictationBar dictation={dictation} />
				</div>
			)}
		</div>
	);
}
