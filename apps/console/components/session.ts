"use client";

/**
 * THE SESSION HOOK (Wave D, owner-approved 2026-09-26): the React adapter
 * over the pure SessionModel (components/session-core.ts — the state
 * machine, testable without a renderer). All mechanics live in the model;
 * this hook re-renders on change and derives the view (core/view.ts
 * projectView — the golden-master grouping, client-side).
 *
 * Every turn is a server-side background process (owner ruling
 * 2026-09-25); the hook is a view. Sends are ONE explicit input event
 * each ({chatId, input}); the turn stream is the VERBATIM AgentEvent
 * passthrough. Status vocabulary (pre-Wave-D parity): ready | submitted
 * | streaming | error.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { ChatInput, LhMessage, QuestionAnswerData } from "@/src/core";
import { SessionModel, type ChatAttachment, type SessionState, type SessionTransport } from "@/components/session-core";

export interface UseChatSessionOptions {
	chatId: string;
	/** The native record seed (server-rendered page or a full sync). */
	initialMessages: LhMessage[];
	/** Reattach on mount: a turn is running server-side with no live view. */
	initiallyInFlight?: boolean;
	/** The initial messages are only the newest page (see SessionModel.loadEarlier). */
	initialHasMore?: boolean;
	/** Turn traffic routes (default: the legacy pi routes). */
	transport?: SessionTransport;
}

export function useChatSession({ chatId, initialMessages, initiallyInFlight, initialHasMore, transport }: UseChatSessionOptions) {
	// The model is per-mount (chatId-keyed component); onChange forces the
	// re-render. The ref pattern keeps it stable across renders.
	const modelRef = useRef<SessionModel | null>(null);
	if (modelRef.current === null) {
		modelRef.current = new SessionModel({ chatId, initialMessages, initialHasMore, transport });
	}
	const model = modelRef.current;
	// The render VERSION — bumped by every model change, so the state memo
	// below recomputes exactly when the model actually changed. (Using the
	// reducer's dispatch as the memo dep was a freeze bug: dispatch is
	// STABLE by contract, so the memo computed once per mount and the view
	// never saw a single model update — no optimistic bubble, no stream, no
	// error banner. The empty-session bug, 2026-09-26.)
	const [version, bump] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		model.onChange = bump;
		return () => {
			model.onChange = undefined;
		};
	}, [model, bump]);

	// Reattach on mount (StrictMode-safe: a newer resume cancels the older).
	// ATTACH-FIRST (owner, reattach round 2026-10-02): the page render just
	// read the record — the blocking record refetch only added handshake
	// latency before the instant replay, so a fresh mount attaches
	// directly. This hook's effect is the SINGLE mount-reattach owner
	// (chat.tsx's duplicate was deleted with the same round).
	//
	// CONNECTION DIET A (owner, 2026-10-10 — parallel-session freeze
	// postmortem): unmount RELEASES the stream connection. The turn is a
	// server-side process — it runs on with zero views; this page's open
	// GET stream (or, pre-diet-B, its POST stream) used to survive
	// navigation, silently pinning one of the browser's 6-per-origin
	// connection slots until the turn settled, streaming into a dead
	// component. Enough leaked views starved every NEW request (navigation
	// RSC fetches included) — the multi-session navigation freeze. Aborting
	// costs nothing: navigating back replays the compacted log + live tail.
	useEffect(() => {
		if (initiallyInFlight) void model.resumeStream(false);
		return () => {
			model.stop();
		};
	}, [initiallyInFlight, model]);

	// The view + state, derived per model change from the model.
	const state = useMemo<SessionState>(() => model.getState(), [model, version] as const);

	// THE TURN-STATE BROADCAST (owner, sidebar round 2026-10-02): the same
	// optimistic machine, propagated — the instant a turn starts locally
	// (submitted: send, answer, session start, reattach, wake attach) the
	// sidebar learns it without waiting for its 2.5s poll; at settle the
	// event clears the row and triggers one immediate refetch. The model
	// stays pure; this adapter owns the window seam (the lh:chat-renamed
	// pattern).
	const prevStatusRef = useRef(state.status);
	useEffect(() => {
		const was = prevStatusRef.current;
		prevStatusRef.current = state.status;
		if (was === state.status) return;
		const running = state.status === "submitted" || state.status === "streaming";
		const wasRunning = was === "submitted" || was === "streaming";
		if (running === wasRunning) return; // submitted→streaming: still running; error↔ready: not
		window.dispatchEvent(new CustomEvent("lh:turn-state", { detail: { id: chatId, running } }));
	}, [state.status, chatId]);

	// The reattach settled terminal → the sync-and-continue seam (chat.tsx).
	const setReattachSettled = useCallback(
		(fn: () => void) => {
			model.setReattachSettled(fn);
		},
		[model],
	);

	const send = useCallback((input: ChatInput) => void model.send(input), [model]);
	const steer = useCallback((text: string, attachments?: ChatAttachment[]) => void model.steer(text, attachments), [model]);
	const submitAnswer = useCallback(
		(tool: string, toolCallId: string, output: QuestionAnswerData) =>
			void model.submitAnswer(tool, toolCallId, output),
		[model],
	);
	const dismissQuestion = useCallback(
		(toolCallId: string, answer: QuestionAnswerData) => void model.dismissQuestion(toolCallId, answer),
		[model],
	);
	const setMessages = useCallback((record: LhMessage[]) => model.setMessages(record), [model]);
	const adoptRecord = useCallback((record: LhMessage[]) => model.adoptRecord(record), [model]);
	const loadEarlier = useCallback((limit?: number) => model.loadEarlier(limit), [model]);
	const stop = useCallback(() => model.stop(), [model]);
	const clearError = useCallback(() => model.clearError(), [model]);
	// skipIfRecordIdle: attaching on a hint (a busy event) that may be late — a finished turn is already in the record.
	const resumeStream = useCallback((skipIfRecordIdle = false) => void model.resumeStream(true, skipIfRecordIdle), [model]);

	return {
		messages: state.messages,
		hasMore: state.hasMore,
		loadingEarlier: state.loadingEarlier,
		loadEarlier,
		nativeMessages: state.nativeMessages,
		status: state.status,
		error: state.error,
		steerQueue: state.steerQueue,
		send,
		steer,
		submitAnswer,
		dismissQuestion,
		setMessages,
		adoptRecord,
		stop,
		clearError,
		resumeStream,
		setReattachSettled,
	};
}
