"use client";

/**
 * One questionnaire session (work-wolfpack-ssPFrEw), shared by both hosts (the floating chat bar and the thread page): the
 * answers of every page, the page cursor, the note typed in the bottom composer, and what the composer's button does.
 *
 * - Next/Back save the page as a draft on wolfd (`PUT pages/:n/draft`) and move the cursor at once; an error moves it back.
 * - The note (text + images typed in the composer while the sheet is expanded) is stored on wolfd (`PUT note`), debounced
 *   {@link NOTE_DEBOUNCE_MS}, flushed on a page change, on submit and on unmount; it is seeded from `pc.note`.
 * - Submit sends the page on screen and the note in one POST; wolfd holds every other page.
 * - Collapsing hands the note to the host's normal draft (`takeNote`), so nothing typed is lost.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CardField, CardFieldAnswer, PendingCard } from "@wolfpack/client";
import { stepsKey } from "@wolfpack/protocol";
import { cardNoteUrl, cardPageDraftUrl, cardSubmitUrl, threadBase } from "@/components/thread-transport";
import { newUploadState, startUploads } from "@/components/attachment-upload";
import { readyRefs, type PendingAttachment } from "@/components/attachments";
import { imagesOf, withImages } from "@/components/ask-images";
import { pageBody, pageFieldIds, reconcile, seedAll, unanswered } from "@/components/ask-answers";
import { joinDictation } from "@/lib/composer-draft";
import { threadSlug, visibleFields, type AttachedRef } from "@/src/core";

export const NOTE_DEBOUNCE_MS = 400;

export type AskActionKind = "next" | "submit" | "confirm" | "send";
export interface AskAction {
	kind: AskActionKind;
	label: string;
	disabled: boolean;
	/** Why the button is disabled ("Answer to continue: Q8, Q10"). */
	hint?: string;
	/** The confirm button was pressed once: it now reads "Send anyway?" and the next press sends. */
	armed?: true;
	/** Accessible name while armed (the label alone would lose which questions are open). */
	ariaLabel?: string;
}

/**
 * What the composer's button does while a questionnaire is open. Collapsed: a normal Send. Expanded: Next (earlier pages) or
 * Submit (last page); with required questions unanswered it is disabled and names them, unless the owner typed a note, in which
 * case it asks to confirm sending the note as a plain message instead.
 */
export function askComposerAction({ pages, page, missing, noteEmpty, expanded, armed = false, own = true }: { pages: number; page: number; missing: readonly string[]; noteEmpty: boolean; expanded: boolean; armed?: boolean; own?: boolean }): AskAction {
	if (!expanded) return { kind: "send", label: "Send", disabled: false };
	const last = page >= pages - 1;
	const label = last ? "Submit" : "Next";
	const kind = last ? "submit" : "next";
	if (missing.length === 0) return { kind, label, disabled: false };
	// A subagent's questionnaire has no plain-message path: the note stays the card's own, so there is no "Send anyway?".
	if (own && !noteEmpty && armed) {
		const hint = missingPhrase(missing);
		return { kind: "confirm", label: "Send anyway?", disabled: false, armed: true, hint, ariaLabel: `Send anyway? ${hint}` };
	}
	if (own && !noteEmpty) return { kind: "confirm", label, disabled: false };
	return { kind, label, disabled: true, hint: `Answer to continue: ${missing.join(", ")}` };
}

/** "Q8 isn't answered" / "Q8 and Q10 aren't answered" / "Q1, Q2 and Q3 aren't answered". */
function missingPhrase(missing: readonly string[]): string {
	const list = missing.length <= 1 ? (missing[0] ?? "") : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
	return `${list} ${missing.length === 1 ? "isn't" : "aren't"} answered`;
}

/** Does a plain message from this thread's composer supersede the card? The thread's own questionnaires and tool confirmations (never a subagent's). */
export const isSupersedable = (p: Pick<PendingCard, "source">): boolean => p.source?.kind !== "subagent";

/** Does the card offer "Send anyway?" (a note sent as a plain message with questions open)? Only the thread's own `ask`; a tool confirmation or a subagent's card never does. */
export const offersSendAnyway = (p: Pick<PendingCard, "source">): boolean => p.source?.kind !== "subagent" && p.source?.kind !== "tool";

/**
 * The paged cards waiting on this thread, in wolfd's order (oldest first): its own questionnaires, its subagents', and tool
 * confirmations (`source.kind === "tool"`: crawl_run, crawl_release, task_done, task_graduate), which are paged ask cards too.
 */
export function askQueue(pending: readonly PendingCard[]): PendingCard[] {
	return pending.filter((p) => p.card.paged === true);
}

/** Where a card's requests go: its asker's thread (a subagent's card is answered on the subagent), else the host's own. */
export function askTarget(target: Pick<AttachedRef, "wolf" | "slug">, pc: Pick<PendingCard, "threadId"> | undefined): Pick<AttachedRef, "wolf" | "slug"> {
	return pc?.threadId ? { wolf: target.wolf, slug: threadSlug(target.wolf, pc.threadId) } : target;
}

export interface AskQueueView {
	/** The card on screen (held by callId; the first when it settled or none was chosen). */
	current: PendingCard | undefined;
	/** Waiting questionnaires in all. */
	count: number;
	/** Call ids of every waiting card. */
	ids: string[];
	/** 0-based position of `current`. */
	index: number;
	/** "you" / "worker: ask-sheet". */
	label: string;
	prev: () => void;
	next: () => void;
}

/** The queue's cursor, held by call id so a refetch (new array, same cards) or a settle elsewhere never jumps to another card. */
export function useAskQueue(queue: readonly PendingCard[]): AskQueueView {
	const [held, setHeld] = useState<string | null>(null);
	const at = Math.max(0, queue.findIndex((p) => p.callId === held));
	const current = queue[at];
	// Pin the card on screen: a late older card (wolfd orders oldest first) must not jump the sheet while the owner types.
	const first = queue[0]?.callId;
	useEffect(() => {
		if (first !== undefined && !queue.some((p) => p.callId === held)) setHeld(current?.callId ?? first);
	}, [first, held]); // eslint-disable-line react-hooks/exhaustive-deps
	const step = (d: number) => {
		const to = queue[(at + d + queue.length) % queue.length];
		if (to) setHeld(to.callId);
	};
	return { current, count: queue.length, ids: queue.map((p) => p.callId), index: at, label: current?.source?.label ?? "you", prev: () => step(-1), next: () => step(1) };
}

export interface NoteState {
	text: string;
	atts: PendingAttachment[];
}

const readyChip = (id: string): PendingAttachment => ({ key: `att-${id}`, name: "image", status: "ready", id });

export interface AskHooks {
	/** Collapse: the note the owner had typed, to be put in the host's normal draft. */
	onCollapse?: (note: NoteState) => void;
	/** The card with this call id was submitted (it is done); it may no longer be the one on screen. */
	onSubmitted?: (callId: string) => void;
	/** Call ids still queued: the state kept for any other card is dropped. */
	queued?: readonly string[];
	/** The card changed on wolfd: read it again. */
	onRefetch?: () => void;
}

export interface AskSession {
	pc: PendingCard;
	/** A paged ask is pending (false: everything else here is inert). */
	active: boolean;
	/** The page on screen (moves at once on Next/Back, back again on an error). */
	page: number;
	pages: number;
	fields: CardField[];
	/** Every page's answers as held locally. */
	draft: Record<string, CardFieldAnswer>;
	set: (id: string, a: CardFieldAnswer) => void;
	clear: (id: string) => void;
	/** Is the sheet expanded over the transcript (the composer is then the note's)? */
	expanded: boolean;
	setExpanded: (v: boolean) => void;
	/** Collapse the sheet: the note moves to the host's normal draft once (onCollapse). */
	collapse: () => void;
	note: NoteState;
	noteEmpty: boolean;
	setNoteText: (v: string) => void;
	/** Dictated words join the note (reads the latest note, so a flush right after a keystroke or another final loses nothing). */
	appendNoteText: (t: string) => void;
	addNoteFiles: (files: File[]) => void;
	removeNoteAtt: (key: string) => void;
	/** Required questions unanswered: this page for Next, the whole card for Submit. */
	missing: string[];
	action: AskAction;
	busy: boolean;
	error: string | null;
	setError: (m: string | null) => void;
	next: () => void;
	back: () => void;
	/**
	 * The composer's button / Enter: Next, Submit, or in the confirm case the first press arms ("Send anyway?") and the second
	 * calls `send` (the host's normal chat send; the note clears only if it succeeds, a failure disarms and keeps it).
	 * (A collapsed sheet is the host's own Send.)
	 */
	press: (send?: SendNote) => void;
	/** Leave the armed state (Esc, the cancel control). Page, answer, note and collapse changes do it by themselves. */
	disarm: () => void;
	/** Collapse: hand the note over (and clear it here) so the host can put it in its normal draft. */
	takeNote: () => NoteState;
	/** Wolfd refused or lost the card: the host should refetch. */
	refetch: () => void;
}

export type SendNote = (text: string, refs: { id: string }[]) => Promise<boolean>;

interface Reply {
	ok: boolean;
	status: number;
	error?: string;
}
async function request(url: string, method: "PUT" | "POST", body: unknown): Promise<Reply> {
	try {
		const res = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
		if (res.ok) return { ok: true, status: res.status };
		const b = (await res.json().catch(() => null)) as { error?: string } | null;
		return { ok: false, status: res.status, error: b?.error };
	} catch (err) {
		return { ok: false, status: 0, error: err instanceof Error ? err.message : "Could not send." };
	}
}

const NO_CARD: PendingCard = { callId: "", threadId: "", card: { tool: "ask", fields: [] }, raisedAt: "" };

/** `card` undefined = no questionnaire pending (hooks must run anyway): the session is then inactive and inert. */
export function useAskSession(host: Pick<AttachedRef, "wolf" | "slug">, card: PendingCard | undefined, hooks: AskHooks = {}): AskSession {
	const pc = card ?? NO_CARD;
	const { wolf, slug } = askTarget(host, card);
	const own = card ? offersSendAnyway(card) : true;
	const callId = pc.callId;
	const hooksRef = useRef(hooks);
	hooksRef.current = hooks;
	const pcRef = useRef(pc);
	pcRef.current = pc;
	const pages = pc.card.steps?.length ?? 1;
	const [page, setPage] = useState(pc.pageIndex ?? 0);
	const pageRef = useRef(page);
	pageRef.current = page;
	const [draft, setDraftState] = useState<Record<string, CardFieldAnswer>>(() => seedAll(pc));
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const [expanded, setExpanded] = useState(true);
	const [error, setError] = useState<string | null>(null);
	// Per card: a late response for a card left behind must not block (or settle) the one on screen.
	const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
	const busy = busyIds.has(callId);
	const flying = useRef(new Set<string>());
	const callIdRef = useRef(callId);
	callIdRef.current = callId;
	const [armed, setArmed] = useState(false);

	// The server moved the cursor (card-pending, a reload, another tab): follow it. Same-value updates leave the local cursor alone.
	useEffect(() => setPage(pc.pageIndex ?? 0), [pc.pageIndex, callId]);
	useEffect(() => setError(null), [callId]);
	// card-pending is an in-place update: answers that left (or no longer fit) go; bound text and saved pages land.
	const draftKey = JSON.stringify([pc.draft ?? null, pc.pageAnswers ?? null]);
	useEffect(() => {
		setDraftState((d) => reconcile(pc, d));
	}, [pc.card, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps

	const set = useCallback((id: string, a: CardFieldAnswer) => setDraftState((d) => ({ ...d, [id]: withImages(a, imagesOf(d[id])) })), []);
	const clear = useCallback((id: string) => setDraftState((d) => (({ [id]: _g, ...rest }) => rest)(d)), []);

	// ---- the note
	const [note, setNote] = useState<NoteState>(() => ({ text: pc.note?.text ?? "", atts: (pc.note?.attachments ?? []).map(readyChip) }));
	const noteRef = useRef(note);
	noteRef.current = note;
	const dirty = useRef(false);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const uploads = useRef(newUploadState());
	const noteBody = (n: NoteState) => {
		const ids = readyRefs(n.atts).map((r) => r.id);
		return { ...(n.text.trim() !== "" ? { text: n.text } : {}), ...(ids.length ? { attachments: ids } : {}) };
	};
	const flushNote = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		// While the submit is in flight wolfd has claimed the card: a note PUT would be a 409 ("questions changed").
		if (!dirty.current || flying.current.has(callId)) return;
		dirty.current = false;
		void request(cardNoteUrl(wolf, slug, callId), "PUT", noteBody(noteRef.current)).then((r) => {
			if (!r.ok) setError(r.error ?? "Could not save the note.");
		});
	}, [wolf, slug, callId]);
	const touchNote = useCallback((fn: (n: NoteState) => NoteState) => {
		dirty.current = true;
		setNote((n) => {
			const next = fn(n);
			noteRef.current = next;
			return next;
		});
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(flushNote, NOTE_DEBOUNCE_MS);
	}, [flushNote]);
	const flushRef = useRef(flushNote);
	flushRef.current = flushNote;
	useEffect(() => () => flushRef.current(), []);
	// The note on wolfd (another host, a reload) seeds this one while nothing typed here is waiting to be saved.
	const noteKey = JSON.stringify(pc.note ?? null);
	useEffect(() => {
		if (dirty.current) return;
		setNote((n) => {
			const text = pc.note?.text ?? "";
			const ids = pc.note?.attachments ?? [];
			const same = n.text === text && n.atts.filter((a) => a.id).map((a) => a.id).join() === ids.join();
			return same || n.atts.some((a) => a.status === "uploading") ? n : { text, atts: ids.map(readyChip) };
		});
	}, [noteKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const setNoteText = useCallback((v: string) => touchNote((n) => ({ ...n, text: v })), [touchNote]);
	// noteRef is updated here, not inside the setState updater (which runs at the next render): a Submit resuming right after the final flush must see the words.
	const appendNoteText = useCallback((t: string) => {
		const next = { ...noteRef.current, text: joinDictation(noteRef.current.text, t) };
		noteRef.current = next;
		touchNote(() => next);
	}, [touchNote]);
	const uploadUrl = `${threadBase(wolf, slug)}/attachments`;
	const addNoteFiles = useCallback((files: File[]) => {
		startUploads(
			files,
			uploadUrl,
			uploads.current,
			(chip) => touchNote((n) => ({ ...n, atts: [...n.atts, chip] })),
			(key, p) => touchNote((n) => ({ ...n, atts: n.atts.map((a) => (a.key === key ? { ...a, ...p } : a)) })),
		);
	}, [uploadUrl, touchNote]);
	const removeNoteAtt = useCallback((key: string) => touchNote((n) => ({ ...n, atts: n.atts.filter((a) => a.key !== key) })), [touchNote]);
	const noteEmpty = note.text.trim() === "" && note.atts.length === 0;
	const uploading = note.atts.some((a) => a.status === "uploading");

	// ---- required questions
	const fieldsOf = useCallback((p: number): CardField[] => pageFieldIds(pc, p).map((id) => pc.card.fields.find((f) => f.id === id)).filter((f): f is CardField => !!f), [pc.card]); // eslint-disable-line react-hooks/exhaustive-deps
	const fields = useMemo(() => fieldsOf(page), [fieldsOf, page]);
	const qn = (f: CardField) => `Q${pc.card.fields.findIndex((x) => x.id === f.id) + 1}`;
	const last = page >= pages - 1;
	const missing = useMemo(() => {
		if (!last) return visibleFields(pc.card, draft).filter((f) => fields.some((x) => x.id === f.id) && unanswered(f, draft)).map(qn);
		return visibleFields(pc.card, draft).filter((f) => unanswered(f, draft)).map(qn);
	}, [pc.card, draft, fields, last]); // eslint-disable-line react-hooks/exhaustive-deps
	const base = askComposerAction({ pages, page, missing, noteEmpty, expanded, armed, own });
	// Armed lives only while the confirm applies to the same open questions on the same page: any change disarms.
	const missingKey = missing.join(",");
	useEffect(() => setArmed(false), [missingKey, noteEmpty, page, expanded, callId]);
	const action: AskAction = uploading ? { ...base, disabled: true } : base;

	// ---- Next, Back, Submit
	const refetch = useCallback(() => hooksRef.current.onRefetch?.(), []);
	const failure = useCallback((r: Reply, what: string) => {
		if (r.status === 409) {
			setError("The questions changed, check your answers.");
			refetch();
		} else if (r.status === 404) {
			setError("This question set is gone.");
			refetch();
		} else setError(r.error ?? `Could not ${what} (${r.status}).`);
	}, [refetch]);
	const go = useCallback(async (to: number) => {
		const cid = callId;
		if (flying.current.has(cid) || to < 0 || to >= pages) return;
		flying.current.add(cid);
		flushNote();
		const from = pageRef.current;
		setError(null);
		setPage(to);
		const r = await request(cardPageDraftUrl(wolf, slug, cid, from), "PUT", { answers: pageBody(fieldsOf(from), draftRef.current, pcRef.current.card), goto: to, stepsKey: stepsKey(pcRef.current.card) });
		flying.current.delete(cid);
		if (r.ok) return refetch();
		if (callIdRef.current !== cid) {
			if (r.status === 409 || r.status === 404) refetch(); // another card is on screen: leave its page, note and error alone
			return;
		}
		setPage(from);
		failure(r, "save the page");
		if (dirty.current && !timer.current) timer.current = setTimeout(flushNote, NOTE_DEBOUNCE_MS); // typed while this was in flight
	}, [wolf, slug, callId, pages, flushNote, fieldsOf, refetch, failure]);
	const next = useCallback(() => void go(pageRef.current + 1), [go]);
	const back = useCallback(() => void go(pageRef.current - 1), [go]);
	const submit = useCallback(async () => {
		const cid = callId;
		if (flying.current.has(cid)) return;
		flying.current.add(cid);
		setBusyIds((s) => new Set(s).add(cid));
		setError(null);
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		dirty.current = false; // the submit body carries the note
		const n = noteBody(noteRef.current);
		const r = await request(cardSubmitUrl(wolf, slug, cid), "POST", { answers: pageBody(fieldsOf(pageRef.current), draftRef.current, pcRef.current.card), ...(Object.keys(n).length ? { note: n } : {}), stepsKey: stepsKey(pcRef.current.card) });
		flying.current.delete(cid);
		setBusyIds((s) => {
			const o = new Set(s);
			o.delete(cid);
			return o;
		});
		const here = callIdRef.current === cid;
		if (r.ok) {
			kept.current.delete(cid);
			// Only the note that was sent is cleared; text typed meanwhile stays as a normal draft and is saved.
			if (here) {
				if (JSON.stringify(noteBody(noteRef.current)) === JSON.stringify(n)) {
					noteRef.current = { text: "", atts: [] };
					setNote(noteRef.current);
				} else {
					dirty.current = true;
					timer.current = setTimeout(flushNote, NOTE_DEBOUNCE_MS);
				}
			}
			return hooksRef.current.onSubmitted?.(cid);
		}
		if (!here) {
			const k = kept.current.get(cid);
			if (k && Object.keys(n).length > 0) k.dirty = true; // the note was never stored: it is saved when the owner comes back
			if (r.status === 409 || r.status === 404) refetch();
			return;
		}
		dirty.current = Object.keys(n).length > 0;
		failure(r, "submit");
	}, [wolf, slug, callId, fieldsOf, failure, flushNote, refetch]);
	const sendNoteAsMessage = useCallback(async (send: SendNote) => {
		const n = noteRef.current;
		const ok = await send(n.text.trim(), readyRefs(n.atts));
		setArmed(false);
		if (!ok) {
			setError("Could not send. Your note and answers are kept.");
			return false;
		}
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		dirty.current = false;
		setNote({ text: "", atts: [] });
		return true;
	}, []);
	const press = useCallback((send?: SendNote) => {
		if (action.disabled) return;
		if (action.kind === "next") next();
		else if (action.kind === "submit") void submit();
		else if (action.kind === "confirm") {
			if (!action.armed) setArmed(true);
			else if (typeof send === "function") void sendNoteAsMessage(send);
		}
	}, [action.disabled, action.kind, action.armed, next, submit, sendNoteAsMessage]);
	const disarm = useCallback(() => setArmed(false), []);
	const takeNote = useCallback((): NoteState => {
		const n = noteRef.current;
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		dirty.current = !flying.current.has(callId); // the cleared note goes to wolfd with the next flush (not while a submit is in flight: wolfd has the card claimed)
		noteRef.current = { text: "", atts: [] };
		setNote(noteRef.current);
		flushNote();
		return n;
	}, [flushNote, callId]);

	const collapse = useCallback(() => {
		setExpanded(false);
		const n = takeNote();
		if (n.text !== "" || n.atts.length > 0) hooksRef.current.onCollapse?.(n);
	}, [takeNote]);
	// A new card opens expanded.
	useEffect(() => setExpanded(true), [callId]);

	// Switching between queued cards: the card left keeps its answers and note here (wolfd holds the saved ones) and gets them back on return.
	// `seen` is what the server showed when the card was left: on return, fields the server changed meanwhile win over the kept ones.
	const kept = useRef(new Map<string, { draft: Record<string, CardFieldAnswer>; note: NoteState; dirty: boolean; seen: Record<string, CardFieldAnswer> }>());
	const serverSeen = useRef(new Map<string, Record<string, CardFieldAnswer>>());
	useEffect(() => {
		if (callId !== "") serverSeen.current.set(callId, seedAll(pcRef.current));
	}, [callId, draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
	useEffect(() => {
		const id = callId;
		const flush = flushNote;
		return () => {
			flush();
			if (id !== "") kept.current.set(id, { draft: draftRef.current, note: noteRef.current, dirty: dirty.current, seen: serverSeen.current.get(id) ?? {} });
		};
	}, [callId]); // eslint-disable-line react-hooks/exhaustive-deps
	// Cards no longer queued lose their kept state.
	const queued = hooks.queued;
	const queuedKey = queued ? queued.join("\n") : null;
	useEffect(() => {
		if (!queued) return;
		for (const k of [...kept.current.keys()]) if (!queued.includes(k)) kept.current.delete(k);
		for (const k of [...serverSeen.current.keys()]) if (!queued.includes(k)) serverSeen.current.delete(k);
	}, [queuedKey]); // eslint-disable-line react-hooks/exhaustive-deps
	const shownId = useRef(callId);
	useEffect(() => {
		if (shownId.current === callId) return;
		shownId.current = callId;
		const back = kept.current.get(callId);
		kept.current.delete(callId);
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
		const p = pcRef.current;
		let d = seedAll(p);
		if (back) {
			d = reconcile(p, back.draft);
			const now = seedAll(p);
			for (const id of Object.keys(now)) if (JSON.stringify(now[id]) !== JSON.stringify(back.seen[id])) d[id] = now[id]!;
		}
		const n = back?.note ?? { text: p.note?.text ?? "", atts: (p.note?.attachments ?? []).map(readyChip) };
		draftRef.current = d;
		noteRef.current = n;
		dirty.current = back?.dirty ?? false;
		setDraftState(d);
		setNote(n);
		if (dirty.current) timer.current = setTimeout(flushNote, NOTE_DEBOUNCE_MS); // a note left unsaved goes now
	}, [callId]); // eslint-disable-line react-hooks/exhaustive-deps

	return {
		pc, active: card !== undefined, collapse, page, pages, fields, draft, set, clear, expanded, setExpanded, note, noteEmpty, setNoteText, appendNoteText, addNoteFiles, removeNoteAtt,
		missing, action, busy, error, setError, next, back, press, disarm, takeNote, refetch,
	};
}
