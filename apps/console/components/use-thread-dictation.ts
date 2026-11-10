"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAttachedThread } from "@/components/attached-thread";
import { finishDictation, useBarDictation, useDictation, type Dictation } from "@/components/dictation";

/**
 * A thread page's dictation. Starting it (the composer's mic button or Cmd+D) ALWAYS attaches this thread and makes the
 * run the floating chat's (invisible while on this page), whose hook (ChatBar, always mounted) outlives page changes, so leaving the page never stops
 * it. If another thread is popped out, its bar run is finished first so its words land in its own draft, unsent. Already
 * popped out: the page just shows and drives the bar's run (its own hook is disabled, so Cmd+D reaches the bar's hook).
 * The words land through the thread's draft (ChatBar writes them with appendToDraft; the mounted page composer picks them
 * up). On the thread's own page nothing floats: the page's composer stays where it is, highlighted while the run is live
 * (ThreadChat), with its own meter and Stop; stopping there docks the chat back (see ChatBar). Leaving the page mid-run
 * makes the floating chat appear with the run still live.
 *
 * The handoff (finish the old run, attach, start the bar's run) takes a few renders, so it is PENDING until the bar's
 * run is live (or failed): a second mic or Cmd+D press meanwhile is a no-op, which also covers the render or two where
 * this hook is still enabled after the attach. Pending also ends on an error, when the thread stops being the popped-out one,
 * and after HANDOFF_MS if the bar's run never goes live. While pending (or popped out with the bar's hook not yet published) the
 * page never starts a plain run of its own. Unmounting or switching thread drops a pending handoff.
 *
 * Without the provider this is a plain page hook: leaving mid-run saves the words to the draft (`onOrphan`).
 * /chat/new has no thread to pop out and uses useDictation directly.
 */
const HANDOFF_MS = 4000;

/** The thread page's questionnaire-note sink. When the page drives the floating chat's run (popped out), that run's `append`
 *  has no view of the page's note, so the page publishes its sink here while the note is the composer. */
let pageNoteAppend: ((t: string) => void) | null = null;
export function setPageNoteAppend(fn: ((t: string) => void) | null) {
	pageNoteAppend = fn;
}
export const getPageNoteAppend = () => pageNoteAppend;

export function useThreadDictation(
	wolf: string,
	slug: string,
	threadId: string,
	append: (text: string) => void,
	onOrphan: (text: string) => void,
	/** Called before the floating chat takes over this thread's input: flush the page composer's draft so the chat's input reads it. */
	beforeHandoff?: () => void,
): Dictation {
	const api = useAttachedThread();
	const bar = useBarDictation();
	const poppedOut = !!api?.attached && api.attached.wolf === wolf && api.attached.threadId === threadId;
	const [want, setWant] = useState(false);
	const pending = useRef(false);
	const started = useRef(false); // the bar's toggle was called; waiting to see it live
	const sawPopped = useRef(false); // this thread became the popped-out one during the handoff
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const apiRef = useRef(api);
	apiRef.current = api;
	const poppedRef = useRef(poppedOut);
	poppedRef.current = poppedOut;

	const settle = useCallback(() => {
		pending.current = false;
		started.current = false;
		sawPopped.current = false;
		if (timer.current) clearTimeout(timer.current);
		timer.current = null;
	}, []);
	const abandon = useCallback(() => {
		settle();
		setWant(false);
	}, [settle]);

	// A different thread (or unmount) drops a handoff that has not started.
	useEffect(() => {
		abandon();
		return settle;
	}, [wolf, threadId, abandon, settle]);

	const own = useDictation({
		append,
		onOrphan,
		enabled: !(poppedOut && bar),
		interceptStart: () => {
			if (!apiRef.current) return false;
			if (pending.current) return true;
			pending.current = true;
			beforeHandoff?.();
			timer.current = setTimeout(abandon, HANDOFF_MS);
			void (async () => {
				try {
					// Popped out already (the bar's hook just not published yet): nothing to move, only wait for the bar.
					if (!poppedRef.current) {
						await finishDictation("bar");
						apiRef.current?.attach({ wolf, threadId, slug });
					}
					setWant(true);
				} catch {
					abandon();
				}
			})();
			return true;
		},
	});

	// Once this thread is the popped-out one and the bar's hook is idle, start the bar's run.
	useEffect(() => {
		if (!want || !poppedOut || !bar || bar.active) return;
		setWant(false);
		started.current = true;
		bar.toggle();
	}, [want, poppedOut, bar]);
	// The handoff ends when the bar's run is live, or failed to start.
	useEffect(() => {
		if (started.current && bar && (bar.active || bar.error)) settle();
	}, [bar, settle]);
	// ...or when this thread stops being the popped-out one while the handoff is pending.
	useEffect(() => {
		if (poppedOut) {
			if (pending.current) sawPopped.current = true;
		} else if (sawPopped.current) abandon();
	}, [poppedOut, abandon]);

	return poppedOut && bar ? bar : own;
}
