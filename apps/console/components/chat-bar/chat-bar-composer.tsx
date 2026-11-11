"use client";

/**
 * The expanded bar's input half (composer, draft, attachments, send): loaded lazily by chat-bar.tsx so the layout only
 * ships the provider and the chip eagerly. It is mounted ONLY while the bar is open and not on the attached thread's own
 * page, so the draft hook never runs beside the page composer (their stale flushes would overwrite each other); on every
 * mount it re-reads the draft, so text typed on the page shows up here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AttachmentChips, Composer } from "@/components/composer/composer";
import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { threadBase } from "@/components/thread-transport";
import { newUploadState, startUploads } from "@/components/composer/attachment-upload";
import { canSendWith, readyInfos, type PendingAttachment } from "@/components/composer/attachments";
import { DictationBar, joinDictation, setDictationFocus, recordingAt, type Dictation } from "@/components/composer/dictation";
import { draftKey, readDraft, useComposerDraft } from "@/lib/composer-draft";
import { abortThread, submitToThread } from "@/components/chat-bar/chat-bar-io";
import { bindingForAction, formatBinding, type AttachedRef } from "@/src/core";

import { mergeRestored } from "@/components/composer/composer-restore";
import { type AskSession, type NoteState } from "@/components/ask/ask-session";

/**
 * `dictation` is owned by ChatBar (it must outlive this component: the composer unmounts when the bar is minimized or the
 * phone is on a thread page, and a run keeps going while the owner browses). This component only shows its meter and
 * registers where the transcript lands while it is mounted; with no composer mounted ChatBar writes it to the draft store.
 */
export default function ChatBarComposer({ target, title, cardOpen = false, askOpen = false, onReplied, dictation, registerAppend, session, registerNoteSink }: { session?: AskSession; registerNoteSink?: (fn: ((n: NoteState) => void) | null) => void; target: AttachedRef; title: string; cardOpen?: boolean; askOpen?: boolean; onReplied?: () => void; dictation: Dictation; registerAppend: (fn: ((t: string) => void) | null) => void }) {
	const api = useAttachedThread()!;
	const { working } = api;
	// Attachments pending in the thread page's composer ride with the PAGE's next send, never this input's (Enter here sends text only).
	const waiting = api.pageAttachments?.threadId === target.threadId ? api.pageAttachments.count : 0;
	const [text, setText] = useState("");
	const textRef = useRef("");
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const recordingHere = recordingAt(null, dictation.phase);
	useEffect(() => {
		setDictationFocus(() => {
			const el = inputRef.current;
			if (!el) return;
			el.focus();
			try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
		});
		return () => setDictationFocus(null);
	}, []);
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

	// The transcript lands in this input (and its draft) while the composer is mounted; while the questionnaire is expanded the input is the NOTE, so it lands there.
	const sessionRef = useRef(session);
	sessionRef.current = session;
	useEffect(() => {
		const fn = (t: string) => {
			const s = sessionRef.current;
			if (s && s.active && s.expanded) s.appendNoteText(t);
			else onChange(joinDictation(textRef.current, t));
		};
		registerAppend(fn);
		return () => registerAppend(null);
	}, [onChange, registerAppend]);

	// Pasted / picked images upload exactly as on the thread page.
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const patch = useCallback((key: string, p: Partial<PendingAttachment>) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, ...p } : a))), []);
	const uploads = useRef(newUploadState());
	const uploadUrl = `${threadBase(target.wolf, target.slug)}/attachments`;
	const onFiles = useCallback((files: File[]) => startUploads(files, uploadUrl, uploads.current, (chip) => setAttachments((prev) => [...prev, chip]), patch), [uploadUrl, patch]);

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
	// Submit while dictating only finishes the run (its last words land in the field); the NEXT press sends. A press while the
	// run is still settling does nothing.
	const sendInFlight = useRef(false);
	const onSend = useCallback(() => {
		if (sendInFlight.current) return;
		if (!dictation.active) return void send();
		sendInFlight.current = true;
		void dictation.finish().finally(() => void (sendInFlight.current = false));
	}, [dictation, send]);

	// While the questionnaire is expanded this composer is the NOTE's (Next / Submit); collapsing hands the note's images to the normal attachments (the text goes through the draft store).
	const noteMode = !!session && session.active && session.expanded;
	useEffect(() => {
		registerNoteSink?.((n) => setAttachments((prev) => [...prev, ...n.atts]));
		return () => registerNoteSink?.(null);
	}, [registerNoteSink]);
	// The text went to the draft store on collapse: re-read it into this composer.
	const wasNote = useRef(noteMode);
	useEffect(() => {
		if (wasNote.current && !noteMode) applyText(readDraft(draftKey(target.wolf, target.threadId)));
		wasNote.current = noteMode;
	}, [noteMode, applyText, target.wolf, target.threadId]);
	const sendNote = useCallback(async (t: string, refs: { id: string }[]) => {
		api.markSent();
		const ok = await submitToThread(target, t, working, refs);
		if (ok) onReplied?.();
		else api.clearSent();
		return ok;
	}, [api, target, working, onReplied]);
	// Submit while dictating only stops the run (the last words land in the note via appendNoteText); the next press does the normal job.
	const noteInFlight = useRef(false);
	const pressNote = useCallback(() => {
		if (noteInFlight.current) return;
		if (!dictation.active) return session?.press(sendNote);
		noteInFlight.current = true;
		void dictation.finish().finally(() => void (noteInFlight.current = false));
	}, [dictation, session, sendNote]);

	return (
		<>
			{noteMode && <p data-testid="ask-armed-live" aria-live="polite" className="sr-only">{session.action.armed ? session.action.ariaLabel : ""}</p>}
			{noteMode && session.action.hint && <p data-testid="ask-missing" role="status" aria-live="polite" className="px-3 pt-2 font-ui text-xs text-muted-foreground">{session.action.hint}</p>}
			{noteMode && session.error && <p role="alert" className="px-3 pt-1 font-ui text-xs text-destructive">{session.error}</p>}
			{error && !noteMode && <p role="alert" className="px-3 pt-1 font-ui text-xs text-destructive">{error}</p>}
			{waiting > 0 && (
				<p data-testid="chat-bar-attachments-waiting" className="px-3 pt-1 font-ui text-xs text-muted-foreground">
					{waiting} attachment{waiting === 1 ? "" : "s"} waiting in the thread
				</p>
			)}
			{askOpen && !noteMode && text.trim() !== "" && <p data-testid="ask-replace-hint" className="px-3 pt-1 font-ui text-xs text-muted-foreground">Sending a message replaces the open questions.</p>}
			<Composer
				busy={noteMode ? false : working}
				{...(noteMode ? { sendLabel: session.action.label, alwaysLabel: true, ...(session.action.armed ? { sendAriaLabel: session.action.ariaLabel, armed: { onCancel: session.disarm } } : {}) } : cardOpen && canSendWith(text, attachments) ? { sendLabel: "Reply instead" } : {})}
				value={noteMode ? session.note.text : text}
				onChange={noteMode ? session.setNoteText : onChange}
				onSend={noteMode ? pressNote : onSend}
				onStop={stop}
				canSend={noteMode ? !session.action.disabled : canSendWith(text, attachments) || (dictation.active && !working)}
				finishing={dictation.phase === "stopping"}
				recording={recordingHere}
				onEscape={dictation.active ? dictation.cancel : undefined}
				enterSends={dictation.active}
				inputRef={inputRef}
				placeholder={`Message ${title}…  (${formatBinding(bindingForAction("focus-chat-bar"))} to focus)`}
				onFiles={noteMode ? session.addNoteFiles : onFiles}
				onPickFiles={noteMode ? session.addNoteFiles : onFiles}
				chips={<AttachmentChips items={noteMode ? session.note.atts : attachments} onRemove={noteMode ? session.removeNoteAtt : (k) => setAttachments((prev) => prev.filter((a) => a.key !== k))} />}
			/>
			<div className="px-3 pb-2" data-testid="dictation-slot">
				<DictationBar dictation={dictation} />
			</div>
		</>
	);
}
