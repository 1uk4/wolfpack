"use client";

import { FEATURE_GRADUATED } from "@/components/thread-closed";
import { isSupersedable } from "@/components/ask-session";
import { createEarlierScroll } from "@/components/earlier-scroll";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { ToolGroup, ToolRow } from "@/components/tool-row";
import { lookupCard, lookupInteractionCard } from "@/components/card-registry";
import { PINNED_OBJECT_ROW_REM, PinnedObjects, pinnedObjectDismissKey } from "@/components/pinned-objects";
import { dismissKey, useDismissed } from "@/components/pin-store";
import { PINNED_CHECKLIST_RESERVE, PinnedChecklist } from "@/components/pinned-checklist";
import { FEATURE_PROGRESS_RESERVE, FeatureProgressPanel, useFeatureProgress } from "@/components/feature-progress";
import { THREAD_COMPACTION_PART, ThreadCompactionDivider, type ThreadCompactionData } from "@/components/thread-compaction-divider";
import { Separator } from "@/components/ui/separator";
import { SubagentMessage } from "@/components/subagent-message";
import { parseSubagentMessage } from "@/src/core/subagent-message";
import { TurnTimer, useTurnStart } from "@/components/turn-timer";
import { useOwnAsk } from "@/components/thread-ask";
import { submitToThread } from "@/components/chat-bar-io";
import { useAttachedStripRow } from "@/components/attached-strip-row";
import { SubagentStrip, stripReservePx, useSubagentChildren } from "@/components/subagent-strip";
import { PanelHostProvider, RightPanelHost } from "@/components/panel-host";
import { AttachmentChips, Composer } from "@/components/composer";
import { ComposerControls, useThreadSettings } from "@/components/composer-controls";
import { useAttachedThread } from "@/components/attached-thread";
import { DictationBar, joinDictation, setDictationFocus, useBarShown, recordingAt } from "@/components/dictation";
import { getInlineDropSink } from "@/components/ask-inline-composer";
import { setPageNoteAppend, useThreadDictation } from "@/components/use-thread-dictation";
import { AttachmentThumbs } from "@/components/attachment-thumbs";
import { newUploadState, startUploads } from "@/components/attachment-upload";
import { canSendWith, dragHasFiles, droppedFiles, pastedImages, readyInfos, type AttachmentInfo, type PendingAttachment } from "@/components/attachments";
import { appendToDraft, draftKey, useComposerDraft, useRereadDraftWhenShown, useRestoreOnSendFailure } from "@/lib/composer-draft";
import { useChatSession } from "@/components/session";
import { useAllThinkingToggle } from "@/components/thinking-toggle";
import { AskRecordCard } from "@/components/ask-record";
import { cardAnswerUrl, cardSkipUrl, attachmentUrl, diagramUrl, threadTransport, type ThreadCardEvent } from "@/components/thread-transport";
import { useOptionalServerEvent } from "@/components/server-events";
import { TopBar } from "@/components/top-bar";
import { ThreadGitRow } from "@/components/thread-git-tree";
import { ThreadContextChip } from "@/components/thread-context";
import type { ThreadWorkspace } from "@wolfpack/client";
import {
	ASSISTANT_CONTENT_CLASS,
	NO_CARDS,
	activeChecklist,
	activeObject,
	PROSE_BLOCK_CLASS,
	foldCardEvent,
	withHeldSkip,
	withSkip,
	parseThreadCards,
	renderItems,
	runOpen,
	withAnswer,
	withHeld,
	type ArtifactPartProps,
	type LhMessage,
	type ThreadCards,
	type ToolItem,
	ATTACHMENTS_PART,
	threadTint,
	threadAccentStyle,
	threadTintSolid,
	type ThreadColorSource,
} from "@/src/core";
import { useThreadColor } from "@/components/use-thread-color";
import type { CardAnswers } from "@wolfpack/client";

const COLUMN = "mx-auto w-full max-w-none px-6";
const DOCK = "mx-auto w-full max-w-[46rem] px-4";

/** One reasoning block: CONTROLLED open state (no remount tricks). A global
 *  ⌘T (epoch bump) stomps it to the global state; a header click sets just
 *  this block until the next ⌘T. A block that mounts late honors the last
 *  global state. Any deliberate open/close disables the post-stream
 *  auto-close so it can't undo the learner's choice. */
function ThreadReasoning({
	allOpen,
	epoch,
	isStreaming,
	text,
}: {
	allOpen: boolean | null;
	epoch: number;
	isStreaming: boolean;
	text: string;
}) {
	const [open, setOpen] = useState(allOpen ?? false);
	const [deliberate, setDeliberate] = useState(allOpen !== null);
	const [seenEpoch, setSeenEpoch] = useState(epoch);
	if (seenEpoch !== epoch) {
		setSeenEpoch(epoch);
		setOpen(allOpen ?? false);
		setDeliberate(true);
	}
	return (
		<Reasoning
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				setDeliberate(true);
			}}
			autoClose={!deliberate}
			isStreaming={isStreaming}
			className="mb-2"
		>
			<ReasoningTrigger />
			<ReasoningContent>{text}</ReasoningContent>
		</Reasoning>
	);
}

/** What the rows need to render tool-raised cards inline (cards.calls keys the card-raising calls). */
interface CardContext {
	wolf: string;
	slug: string;
	cards: ThreadCards;
	answering: string | null;
	onAnswer: (callId: string, answers: CardAnswers) => void;
	onSkip: (callId: string) => void;
}

/** A tool call that raised an interaction card renders as that card (its renderer comes from the card registry). */
function InlineCard({ callId, ctx }: { callId: string; ctx: CardContext }) {
	const call = ctx.cards.calls[callId];
	const entry = call && lookupInteractionCard(call.card.tool);
	if (!call || !entry) return null;
	const { Renderer } = entry;
	// A paged `ask` is a compact Q→A record in the transcript (the chat bar's sheet owns answering it).
	if (call.card.paged) {
		return (
			<AskRecordCard
				callId={callId}
				card={call.card}
				closed={call.closed}
				dismissed={call.dismissed}
				answer={call.answer}
				pageAnswers={call.pageAnswers}
				pagesDone={call.pagesDone}
				note={call.note}
				attachmentUrl={(id) => attachmentUrl(ctx.wolf, ctx.slug, id)}
				draft={call.draft}
				pending={ctx.cards.pending.some((p) => p.callId === callId)}
				diagramUrl={(id) => diagramUrl(ctx.wolf, ctx.slug, id)}
			/>
		);
	}
	return (
		<Renderer
			callId={callId}
			card={call.card}
			answer={call.answer}
			dismissed={call.dismissed}
			closed={call.closed}
			heldAnswer={call.heldAnswer}
			heldSkip={call.heldSkip}
			pending={ctx.cards.pending.some((p) => p.callId === callId)}
			submitting={ctx.answering === callId}
			onAnswer={(answers) => ctx.onAnswer(callId, answers)}
			onSkip={() => ctx.onSkip(callId)}
		/>
	);
}

const raisesCard = (ctx: CardContext, callId: string): boolean => {
	const call = ctx.cards.calls[callId];
	return call !== undefined && lookupInteractionCard(call.card.tool) !== undefined;
};

function ToolItemRow({ item, open, onOpenChange, cardCtx }: { item: ToolItem; open: boolean; onOpenChange: (open: boolean) => void; cardCtx: CardContext }) {
	if (raisesCard(cardCtx, item.entry.callId)) return <InlineCard callId={item.entry.callId} ctx={cardCtx} />;
	const card = lookupCard("tool", item.entry.name);
	const Renderer = card?.threadRow ? card.Renderer : undefined;
	return (
		<ToolRow
			entry={item.entry}
			open={open}
			onOpenChange={onOpenChange}
			artifact={Renderer ? { Renderer, part: item.part as ArtifactPartProps["part"] } : undefined}
		/>
	);
}

/**
 * The chat view for one ConsoleClient thread: the session model + projected
 * view (session-core / core view) driven by the thread transport — history
 * seeded from getThread(), sends through submit(), the turn rendered from
 * the watch() stream. Server-agnostic: it only knows the /api/wolves routes
 * (components/thread-transport.ts).
 *
 * Deliberately lean next to the legacy Chat: no rename/settings/jobs/
 * questions/compaction — the console client has no such calls yet.
 */
const NO_COLOR_THREADS: readonly ThreadColorSource[] = [];

function ThreadChatInner({
	wolf,
	slug,
	threadId,
	title,
	workspace,
	initialTurnStartedAt,
	initialMessages,
	initialHasMore,
	initiallyInFlight,
	initialCards = NO_CARDS,
	closedReason: closedReasonProp,
	initialBound,
	parentThreadId,
	colorThreads = NO_COLOR_THREADS,
	wolfColor,
}: {
	wolf: string;
	slug: string;
	/** The client's thread id — the sidebar's key for turn-state patches. */
	threadId: string;
	title: string;
	/** Header git tree: the thread's git workspace (absent for a non-git thread). */
	workspace?: ThreadWorkspace;
	/** When the turn running at page load began (ThreadDetail.turnStartedAt); absent from an older server. */
	initialTurnStartedAt?: string;
	initialMessages: LhMessage[];
	/** Only the newest page is loaded: a "Show earlier" divider tops the list. */
	initialHasMore?: boolean;
	initiallyInFlight?: boolean;
	/** Interaction cards of the thread record (pending ones + the card-raising calls of the history). */
	initialCards?: ThreadCards;
	/** Set when the thread is read-only history (its feature graduated): the notice replaces the composer. */
	closedReason?: string;
	/** The work item the thread is bound to at load (`boundItem ?? boundWorkItem`): its progress panel replaces the floating checklist from the first paint. */
	initialBound?: string;
	/** A subagent thread: the thread that spawned it (it shows that thread's color). */
	parentThreadId?: string;
	/** The wolf's threads (id, kind, parent) as loaded: the lookup `threadColor(thread, all)` needs. Includes this thread. */
	colorThreads?: readonly ThreadColorSource[];
	/** The wolf's chosen color at page load; the live roster (attached-thread provider) overrides it after a Settings change. */
	wolfColor?: string;
}) {
	// A graduation closes the thread: the wolf pushes thread-updated {closed}, so the notice shows with no message sent.
	const [closedLive, setClosedLive] = useState<string | undefined>(undefined);
	useOptionalServerEvent("thread-updated", (p) => {
		if (p.wolf === wolf && p.thread.id === threadId && p.thread.closed) setClosedLive(p.thread.closedReason ?? FEATURE_GRADUATED);
	});
	const closedReason = closedReasonProp ?? closedLive;
	// Live card events reach the chat through a ref: the transport is created before the cards state exists.
	const cardEventRef = useRef<(ev: ThreadCardEvent) => void>(() => {});
	const pageRef = useRef<(json: unknown) => void>(() => {});
	const transport = useMemo(() => threadTransport(wolf, slug, (ev) => cardEventRef.current(ev), (json) => pageRef.current(json)), [wolf, slug]);
	const { messages, status, turnStartedAt, error, send, steer, clearError, resumeStream, hasMore, loadingEarlier, earlierCount, loadEarlier } = useChatSession({
		chatId: threadId,
		initialMessages,
		initialHasMore,
		initiallyInFlight,
		transport,
	});
	const threadSettings = useThreadSettings(wolf, slug);
	// A faint tint of the thread's color (the one its id gives; a subagent's = its parent's) behind the conversation.
	const colorApi = useAttachedThread();
	const own = useMemo(() => colorThreads.find((t) => t.id === threadId), [colorThreads, threadId]);
	const tintHex = useThreadColor({ ...own, id: threadId, ...(parentThreadId !== undefined ? { parentThreadId } : {}) }, colorThreads, colorApi?.wolves.find((w) => w.name === wolf)?.color ?? wolfColor).hex;
	const tint = threadTint(tintHex);
	const tintSolid = threadTintSolid(tintHex);
	const [cards, setCards] = useState<ThreadCards>(initialCards);
	const [answering, setAnswering] = useState<string | null>(null);
	const [cardError, setCardError] = useState<string | null>(null);
	// An answer steered into the turn that is still running: shown until that turn ends (not an error).
	const [sendPending, setSendPendingState] = useState(false);
	const sendPendingRef = useRef(false);
	const statusRef = useRef<string>("ready");
	const setSendPending = useCallback((v: boolean) => {
		sendPendingRef.current = v;
		setSendPendingState(v);
	}, []);
	// Feature progress: bumped when a turn ends, so the panel's live data refetches.
	const [progressTick, setProgressTick] = useState(0);
	// The thread record is the truth for cards: refetched whenever a turn settles (a turn that ended on a card), and
	// after an answer that did not start a turn (siblings still wait).
	// Sequenced: only the newest response applies, and a response that a card event overtook is refetched, so a slow
	// record can never undo a newer live event.
	const refreshSeq = useRef(0);
	const cardEpoch = useRef(0);
	const refreshCards = useCallback(async () => {
		const seq = ++refreshSeq.current;
		const epoch = cardEpoch.current;
		try {
			const res = await fetch(transport.recordUrl);
			if (!res.ok || seq !== refreshSeq.current) return;
			const next = parseThreadCards(await res.json());
			if (seq !== refreshSeq.current) return;
			if (epoch !== cardEpoch.current) return void refreshCards(); // a card event landed meanwhile: fetch again
			// The record is the newest page: keep the calls of older pages already loaded.
			if (next) setCards((prev) => ({ pending: next.pending, calls: { ...prev.calls, ...next.calls } }));
		} catch {
			/* the next settle refetches */
		}
	}, [transport]);
	// "Show earlier": the divider's button and reaching the top of the scroll container both load the next older page.
	// The scroll position is kept by measuring scrollHeight/scrollTop before the fetch and restoring the delta once the
	// prepended rows are laid out (useLayoutEffect, before paint), so the message the operator was reading stays put.
	const earlierRef = useRef<HTMLDivElement | null>(null);
	const scrollKeep = useRef(createEarlierScroll()).current;
	const showEarlier = useCallback(() => scrollKeep.run(scrollParent(earlierRef.current), () => loadEarlier()), [loadEarlier, scrollKeep]);
	// Keyed on the count of paged-in rows (earlierCount), not the whole list: a streamed message never triggers a restore,
	// and a page that adds no rows leaves nothing pending.
	useLayoutEffect(() => scrollKeep.restore(), [earlierCount, scrollKeep]);
	// The top trigger arms only after the list has been at the bottom once (the initial scroll-to-bottom must not look
	// like "reached the top"), then stays armed: it is not rebuilt when streamed messages arrive.
	const [atBottomOnce, setAtBottomOnce] = useState(false);
	useEffect(() => {
		if (atBottomOnce || !hasMore) return;
		const el = scrollParent(earlierRef.current);
		if (!el) return;
		const check = () => {
			if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) setAtBottomOnce(true);
		};
		check();
		el.addEventListener("scroll", check, { passive: true });
		return () => el.removeEventListener("scroll", check);
	}, [atBottomOnce, hasMore]);
	useEffect(() => {
		const node = earlierRef.current;
		if (!hasMore || !atBottomOnce || !node || typeof IntersectionObserver === "undefined") return;
		const io = new IntersectionObserver((entries) => {
			if (entries.some((e) => e.isIntersecting)) void showEarlier();
		}, { root: scrollParent(node) });
		io.observe(node);
		return () => io.disconnect();
	}, [hasMore, atBottomOnce, showEarlier]);
	// An older page brings its own card calls (answered cards in history); pending cards are always in the newest page.
	useEffect(() => {
		pageRef.current = (json) => {
			const older = parseThreadCards(json);
			if (older) setCards((prev) => ({ pending: prev.pending, calls: { ...older.calls, ...prev.calls } }));
		};
	});
	// A card raised mid-stream shows at once (no wait for the turn to settle); an answer's text comes with the record.
	useEffect(() => {
		cardEventRef.current = (ev) => {
			cardEpoch.current++;
			setCards((c) => foldCardEvent(c, ev));
			// A chat message superseded the cards: nothing of ours is waiting to send any more.
			if (ev.type === "card-settled" && ev.closed === "superseded") setSendPending(false);
			// Answered or skipped: the record carries the result text.
			if (ev.type === "card-settled" && (ev.outcome === "answered" || ev.closed === "skipped")) void refreshCards();
		};
	});
	// The open thread follows the wolf's activity. A turn this console did not start (a steer delivered by wolfd, a
	// harness revision) announces itself only as a busy status: attach to its stream. A turn we are already running
	// (our own submit/answer) owns the view; a busy that lands mid-stream may be a back-to-back next turn, so it is
	// remembered and attached when the current stream settles.
	const busyMissed = useRef(false);
	useOptionalServerEvent("needs-you-changed", (p) => {
		if (p.wolf !== wolf) return;
		if (p.threadId !== undefined && p.threadId !== threadId) return; // another thread of the wolf
		const running = status === "submitted" || status === "streaming";
		if (p.kind === "status" && p.status === "busy") {
			if (!running) resumeStream(true);
			else if (status === "streaming") busyMissed.current = true;
			return;
		}
		if (running) return;
		void refreshCards(); // idle: a held answer given from the sidebar, a card answered elsewhere
	});
	statusRef.current = status;
	const prevStatus = useRef(status);
	useEffect(() => {
		const was = prevStatus.current;
		prevStatus.current = status;
		const wasRunning = was === "submitted" || was === "streaming";
		if (wasRunning && status === "ready") {
			// A steered answer is placed when the turn ends and starts the next turn: attach to it.
			const followOn = sendPendingRef.current;
			setSendPending(false);
			void refreshCards();
			setProgressTick((n) => n + 1);
			if (busyMissed.current) resumeStream();
			else if (followOn) resumeStream(true); // only if the record shows a turn running
		}
		if (status === "error") setSendPending(false);
		if (status === "ready" || status === "error") busyMissed.current = false;
	}, [status, refreshCards, resumeStream, setSendPending]);
	const answerInFlight = useRef(false);
	// An answer (answers given) or a skip (no answers) of one card: the same POST/ack handling.
	const resolveCard = useCallback(
		async (callId: string, answers?: CardAnswers) => {
			if (answerInFlight.current) return; // double click / Enter: one POST
			answerInFlight.current = true;
			setAnswering(callId);
			setCardError(null);
			try {
				const res = await fetch(answers ? cardAnswerUrl(wolf, slug, callId) : cardSkipUrl(wolf, slug, callId), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: answers ? JSON.stringify({ answers }) : undefined,
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					setCardError(body?.error ?? `Could not send the ${answers ? "answer" : "skip"} (${res.status}).`);
					// 404: the card is gone (superseded or answered elsewhere): show the thread as it is now.
					if (res.status === 404) void refreshCards();
					return;
				}
				const ack = (await res.json()) as { disposition?: string };
				// Queued = sibling cards still wait: the wolf holds the answer and the card stays changeable.
				// Steered = a turn is running: the answer joins it like a chat message typed mid-turn, so the same
				// stream keeps going (no new turn to attach to); the card is answered, the send shown as pending.
				// Otherwise the answer starts the next turn: attach to it.
				if (ack.disposition === "steered") {
					setCards((c) => (answers ? withAnswer(c, callId, answers) : withSkip(c, callId)));
					// This console sees no running turn (a reload mid-turn, a second client): attach to the turn the
					// answer joined instead of waiting for a transition that will not come.
					if (statusRef.current === "ready" || statusRef.current === "error") resumeStream(true);
					else setSendPending(true);
				} else if (ack.disposition === "queued") {
					setCards((c) => (answers ? withHeld(c, callId, answers) : withHeldSkip(c, callId)));
					void refreshCards();
				} else {
					setCards((c) => (answers ? withAnswer(c, callId, answers) : withSkip(c, callId)));
					resumeStream();
				}
			} catch (err) {
				setCardError(err instanceof Error ? err.message : `Could not send the ${answers ? "answer" : "skip"}.`);
			} finally {
				answerInFlight.current = false;
				setAnswering(null);
			}
		},
		[wolf, slug, resumeStream, refreshCards, setSendPending],
	);
	const cardCtx: CardContext = { wolf, slug, cards, answering, onAnswer: (callId, answers) => void resolveCard(callId, answers), onSkip: (callId) => void resolveCard(callId) };
	const { allOpen: allThinkingOpen, epoch: thinkingEpoch } = useAllThinkingToggle();
	const [text, setText] = useState("");
	// Ref mirror of the composer text: a dictation flush lands via setState, which a send resuming after
	// `await dictation.finish()` cannot observe in time (same law as chat.tsx).
	const textRef = useRef("");
	const scheduleDraft = useRef<(v: string) => void>(() => {});
	const applyText = useCallback((v: string) => {
		textRef.current = v;
		setText(v);
		scheduleDraft.current(v);
	}, []);
	// Unsent text survives leaving the thread, switching wolves and reloads (localStorage, text only).
	// Restore callback: deliberately skips applyText, so a restored draft is not re-scheduled for writing, does not
	// focus the composer and does not touch the dictation state.
	// While the floating chat is shown for this thread (a live run followed the owner away and back through a route where the
	// bar still shows, or a phone sheet), it owns the text: the composer card unmounts (attachments live up here in
	// ThreadChat, so pending ones survive); `ownedByBar` makes the draft hook inert meanwhile (a stale text must not
	// overwrite or absorb the chat's); when it docks, the composer re-reads the draft via useRereadDraftWhenShown below.
	// Dictating on this thread's own page does NOT do this: the composer stays and highlights itself.
	const attachedApi = useAttachedThread();
	const barShown = useBarShown();
	const barOwnsInput = !!attachedApi?.attached && attachedApi.attached.wolf === wolf && attachedApi.attached.threadId === threadId && barShown;
	const ownedByBar = useRef(false);
	ownedByBar.current = barOwnsInput;
	const draftSchedule = useComposerDraft(
		wolf,
		threadId,
		textRef,
		(v) => {
			textRef.current = v;
			setText(v);
		},
		ownedByBar,
	);
	scheduleDraft.current = draftSchedule;
	// Voice dictation: finals append to the composer unless a card field claims the target (see AskCard).
	// Leaving the page mid-run saves what was heard into this thread's draft. This hook MUST stay declared after
	// useComposerDraft: cleanups run in declaration order, so the composer's unmount flush runs first and the orphan
	// append lands on top of it (the reverse order would lose the words).
	// While the questionnaire's note is the composer (noteMode, below), finals join the note instead of the hidden draft.
	const noteAppendRef = useRef<((t: string) => void) | null>(null);
	const dictation = useThreadDictation(
		wolf,
		slug,
		threadId,
		(t) => (noteAppendRef.current ? noteAppendRef.current(t) : applyText(joinDictation(textRef.current, t))),
		(t) => appendToDraft(draftKey(wolf, threadId), t),
		draftSchedule.flush, // the chat's input reads the draft: write it now and drop the pending debounce
	);
	useRereadDraftWhenShown(barOwnsInput, wolf, threadId, textRef, (v) => {
		textRef.current = v;
		setText(v);
	});
	// Expand state of tool rows/groups, keyed by row key (see runOpen): survives a row joining a group.
	const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
	const setRowOpen = useCallback(
		(key: string) => (open: boolean) => setOpenRows((prev) => (prev[key] === open ? prev : { ...prev, [key]: open })),
		[],
	);
	// Per assistant message, its render items; a message with none (e.g. a revision-only turn whose tool row is hidden) draws no shell.
	const itemsByMessage = useMemo(
		() => messages.map((m, mi) => (m.role === "assistant" ? renderItems(m.parts, status === "streaming" && mi === messages.length - 1) : null)),
		[messages, status],
	);
	// A thread bound to a feature (or one of its tasks) pins the feature's progress panel INSTEAD of the floating checklist.
	const featureProgress = useFeatureProgress(wolf, threadId, progressTick);
	const progressShown = featureProgress.state.phase === "ready";
	const checklistReplaced = progressShown || (featureProgress.state.phase === "pending" && initialBound !== undefined);
	const active = useMemo(() => activeChecklist(messages), [messages]);
	const dismissedChecklist = useDismissed(active ? dismissKey(threadId, active.objectId) : undefined);
	const pinned = dismissedChecklist || checklistReplaced ? undefined : active;
	// Decisions and graphs pin in any thread (stacked under the checklist / feature progress), updating in place per objectId.
	const activeDecision = useMemo(() => activeObject(messages, "decision"), [messages]);
	const activeGraph = useMemo(() => activeObject(messages, "graph"), [messages]);
	const decisionDismissed = useDismissed(pinnedObjectDismissKey(threadId, activeDecision));
	const graphDismissed = useDismissed(pinnedObjectDismissKey(threadId, activeGraph));
	const pinnedObjects = [decisionDismissed ? undefined : activeDecision, graphDismissed ? undefined : activeGraph].filter((a): a is NonNullable<typeof a> => a !== undefined);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const recordingHere = recordingAt(null, dictation?.phase ?? "idle");
	// Starting dictation (button, ⌘D) puts the caret at the end of this composer (the note box in note mode: same textarea).
	useEffect(() => {
		const focusEnd = () => {
			const el = inputRef.current;
			if (!el) return;
			el.focus();
			try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
		};
		setDictationFocus(focusEnd);
		return () => setDictationFocus(null);
	}, []);
	// The composer dock overlays the list (absolute, bottom-0) and its height varies (controls wrap on a phone, chips, dictation bar,
	// subagent strip, safe-area inset). Measure it so the tail spacer clears the dock and its gradient glow exactly.
	const [dockEl, setDockEl] = useState<HTMLDivElement | null>(null);
	const [dockHeight, setDockHeight] = useState<number | null>(null);
	useEffect(() => {
		if (!dockEl) return void setDockHeight(null); // the dock is gone (closed-thread notice): back to the pre-measure default
		if (typeof ResizeObserver !== "function") return;
		const read = () => setDockHeight(Math.ceil(dockEl.getBoundingClientRect().height));
		read();
		const ro = new ResizeObserver(read);
		ro.observe(dockEl);
		return () => ro.disconnect();
	}, [dockEl]);
	const busy = status === "submitted" || status === "streaming";
	const turnStart = useTurnStart(threadId, busy, turnStartedAt, initialTurnStartedAt);
	const subagents = useSubagentChildren(wolf, slug, threadId);
	const attachedRow = useAttachedStripRow(wolf, threadId);
	const stripReserve = stripReservePx(subagents, Date.now(), attachedRow);
	const subagentOrigins = useMemo(
		() => messages.map((m) => (m.role === "user" ? parseSubagentMessage(m.parts.filter((p) => p.type === "text").map((p) => p.text).join("\n")) : undefined)),
		[messages],
	);

	// Pasted, dropped or picked images: prechecked, then uploaded to the wolf at once (a chip tracks each, an error
	// chip carries the reason), sent as refs with the next message.
	const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
	const patchAttachment = useCallback(
		(key: string, patch: Partial<PendingAttachment>) => setAttachments((prev) => prev.map((a) => (a.key === key ? { ...a, ...patch } : a))),
		[],
	);
	const uploadState = useRef(newUploadState());
	const onFiles = useCallback((files: File[]) => startUploads(files, transport.uploadUrl!, uploadState.current, (chip) => setAttachments((prev) => [...prev, chip]), patchAttachment), [transport, patchAttachment]);
	const [dragging, setDragging] = useState(false);
	const publishAttachments = attachedApi?.setPageAttachments;
	const waitingAttachments = attachments.filter((a) => a.status !== "error").length;
	useEffect(() => {
		publishAttachments?.(threadId, waitingAttachments);
		return () => publishAttachments?.(threadId, 0);
	}, [publishAttachments, threadId, waitingAttachments]);
	const removeAttachment = useCallback((key: string) => setAttachments((prev) => prev.filter((a) => a.key !== key)), []);
	// A paged `ask` pending on this thread: its questionnaire sheet lives here (the floating bar never mounts on this page). Collapsing it moves the note into this composer's own draft.
	const ask = useOwnAsk({ wolf, slug, threadId }, busy, dockHeight, dictation, (n) => {
		if (n.text.trim() !== "") applyText(joinDictation(textRef.current, n.text));
		if (n.atts.length > 0) setAttachments((prev) => [...prev, ...n.atts]);
	});
	const session = ask.session;
	/** The composer is the questionnaire note's (Next / Submit), not the chat's. */
	const noteMode = ask.pending && ask.sheetShown && session.expanded && !ask.composing;
	noteAppendRef.current = noteMode ? session.appendNoteText : null;
	// Drop and paste work anywhere on the page, not only inside the chat column (the floating bar, sheet and overlays sit outside that div):
	// a file drag is always taken so the browser never opens the file, and a drop or an image paste that nothing handled goes to the open
	// answer, else the note, else the composer. Handlers that already took the event (the column, a composer's own paste) win.
	const fileSinkRef = useRef<(files: File[]) => void>(() => {});
	fileSinkRef.current = (files) => (getInlineDropSink() ?? (noteMode ? session.addNoteFiles : onFiles))(files);
	useEffect(() => {
		const over = (e: DragEvent) => {
			if (dragHasFiles(e.dataTransfer)) e.preventDefault();
		};
		const drop = (e: DragEvent) => {
			if (e.defaultPrevented || !dragHasFiles(e.dataTransfer)) return;
			e.preventDefault();
			fileSinkRef.current(droppedFiles(e.dataTransfer));
		};
		const paste = (e: ClipboardEvent) => {
			if (e.defaultPrevented) return;
			const files = pastedImages(e.clipboardData);
			if (files.length === 0) return;
			e.preventDefault();
			fileSinkRef.current(files);
		};
		document.addEventListener("dragover", over);
		document.addEventListener("drop", drop);
		document.addEventListener("paste", paste);
		return () => {
			document.removeEventListener("dragover", over);
			document.removeEventListener("drop", drop);
			document.removeEventListener("paste", paste);
		};
	}, []);
	// Popped out, the page drives the floating chat's run, whose append can't see the note: publish the sink.
	useEffect(() => {
		setPageNoteAppend(noteMode ? session.appendNoteText : null);
		return () => setPageNoteAppend(null);
	}, [noteMode, session.appendNoteText]);

	// A run that ends hands the cursor to the composer, unless a card field holds the dictation target.
	const dictationWasActive = useRef(false);
	useEffect(() => {
		if (dictation.active) dictationWasActive.current = true;
		else if (dictationWasActive.current) {
			dictationWasActive.current = false;
			if (!document.querySelector("[data-dictation-claimed]")) inputRef.current?.focus();
		}
	}, [dictation.active]);

	const replyInFlight = useRef(false);
	const beginSend = useRestoreOnSendFailure(error, status, textRef, applyText);
	const doSend = useCallback(() => {
		const t = textRef.current.trim();
		if (!canSendWith(t, attachments)) return;
		const refs = readyInfos(attachments);
		applyText("");
		setSendPending(false);
		beginSend(t, busy); // a failed send/steer puts the text back (unless the user typed anew)
		setAttachments((prev) => prev.filter((a) => a.status === "uploading"));
		// A running turn takes the message as a steer, attachments included (the submit route accepts them with
		// whenBusy "steer"); Stop is the abort.
		if (busy) return steer(t, refs);
		send({ type: "text", text: t, ...(refs.length ? { attachments: refs } : {}) });
	}, [busy, send, steer, attachments, applyText, beginSend, setSendPending]);
	// Submit while dictating only finishes the run (the spoken tail lands in the field); the next press sends. A press
	// while the run is still settling does nothing.
	const sendInFlight = useRef(false);
	const onSend = useCallback(() => {
		if (sendInFlight.current) return;
		if (!dictation.active) return doSend();
		sendInFlight.current = true;
		// Stop only: the first press puts the final transcript in the field; the next press sends it.
		void dictation.finish().finally(() => void (sendInFlight.current = false));
	}, [dictation, doSend]);
	// Submit/Next in note mode while dictating only stops the run (the last words land in the note); the next press does the normal job.
	const pressNoteRef = useRef<() => void>(() => {});
	pressNoteRef.current = () => session.press((t, refs) => submitToThread({ wolf, slug }, t, busy, refs).then((ok) => { if (ok) ask.settle(); return ok; }));
	const noteInFlight = useRef(false);
	const onNoteSend = useCallback(() => {
		if (noteInFlight.current) return;
		if (!dictation.active) return pressNoteRef.current();
		noteInFlight.current = true;
		void dictation.finish().finally(() => void (noteInFlight.current = false));
	}, [dictation]);

	const onStop = useCallback(() => {
		setSendPending(false);
		void fetch(transport.abortUrl!, { method: "POST" }).catch(() => {
			/* the turn settles on its own */
		});
	}, [transport, setSendPending]);

	return (
		<div
			className="flex h-dvh"
			data-testid="thread-chat"
			data-thread={threadId}
			data-dragging={dragging || undefined}
			style={{ ...(threadAccentStyle(tintHex) as CSSProperties), backgroundColor: tintSolid }}
			onDragOver={(e) => {
				if (!dragHasFiles(e.dataTransfer)) return;
				e.preventDefault(); // take the drop instead of the browser opening the file
				setDragging(true);
			}}
			onDragLeave={(e) => {
				if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
			}}
			onDrop={(e) => {
				if (!dragHasFiles(e.dataTransfer)) return;
				e.preventDefault();
				setDragging(false);
				// Follows focus: an open answer composer takes it, else the note's chips while the questionnaire note is the composer, else the chat's.
				(getInlineDropSink() ?? (noteMode ? session.addNoteFiles : onFiles))(droppedFiles(e.dataTransfer));
			}}
		>
			<div className="flex min-w-0 flex-1 flex-col">
				<TopBar>
					<span className="min-w-0 shrink truncate font-title text-lg tracking-tight md:min-w-4 md:text-3xl">{title}</span>
					<span className="text-xs uppercase tracking-wide text-muted-foreground max-md:hidden">{wolf}</span>
					<TurnTimer startedAt={turnStart} />
					<ThreadContextChip wolf={wolf} slug={slug} threadId={threadId} refreshKey={busy} />
				</TopBar>
				{/* header row 2: the git tree, refreshed when a turn ends; absent for a non-git thread */}
				<ThreadGitRow wolf={wolf} slug={slug} threadId={threadId} workspace={workspace} refreshKey={busy} title={title} />
				<div className="relative flex min-h-0 flex-1" data-testid="thread-tint" data-thread-color={tintHex} style={{ backgroundColor: tint }}>
					<Conversation className="h-full min-w-0 flex-1" initial="instant">
						<ConversationContent className="min-h-full gap-0 p-0">
							<div className={`${COLUMN} flex flex-1 flex-col gap-4 ${progressShown ? FEATURE_PROGRESS_RESERVE : pinned ? PINNED_CHECKLIST_RESERVE : "pt-4 max-md:pt-14"}`}>
								{pinnedObjects.length > 0 && <div aria-hidden style={{ height: `${pinnedObjects.length * PINNED_OBJECT_ROW_REM}rem` }} className="-mb-4 shrink-0" />}
								{messages.length === 0 && !busy && (
									<ConversationEmptyState title={title} description="Say something to start a turn." />
								)}
								{hasMore && (
									<div ref={earlierRef} data-testid="show-earlier" className="flex justify-center py-2">
										<button
											type="button"
											disabled={loadingEarlier}
											onClick={() => void showEarlier()}
											className="rounded-full border px-3 py-1 font-ui text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
										>
											{loadingEarlier ? "Loading earlier…" : "Show earlier"}
										</button>
									</div>
								)}
								{messages.map((m, mi) => (
									<Fragment key={m.id || `m-${mi}`}>
										{m.role === "user" && m.parts.some((p) => p.type === THREAD_COMPACTION_PART) ? (
											<ThreadCompactionDivider data={m.parts.find((p) => p.type === THREAD_COMPACTION_PART)!.data as ThreadCompactionData} />
										) : m.role === "user" && subagentOrigins[mi] ? (
											<SubagentMessage origin={subagentOrigins[mi]!} children={subagents} wolf={wolf} />
										) : m.role === "user" ? (
											<div
												data-testid="user-message"
												className="my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card py-1 pl-[14px] pr-4 font-ui text-xs"
											>
												<div className="font-medium uppercase tracking-wide text-muted-foreground">You</div>
												<div className="wp-prose whitespace-pre-wrap text-foreground">
													{m.parts
														.filter((p) => p.type === "text")
														.map((p) => p.text)
														.join("\n")}
												</div>
												<AttachmentThumbs
													items={(m.parts.find((p) => p.type === ATTACHMENTS_PART)?.data as AttachmentInfo[] | undefined) ?? []}
													urlFor={transport.attachmentUrl}
												/>
											</div>
										) : itemsByMessage[mi]!.length === 0 && !(status === "streaming" && mi === messages.length - 1) ? null : (
											<Message from="assistant" className="max-w-full">
												<MessageContent className={ASSISTANT_CONTENT_CLASS}>
													{itemsByMessage[mi]!.map((item) => {
														switch (item.kind) {
															case "text":
																return (
																	<div key={item.part.id || item.index} className={PROSE_BLOCK_CLASS}>
																		<MessageResponse>{item.part.text}</MessageResponse>
																	</div>
																);
															case "reasoning":
																return (
																	<ThreadReasoning
																		key={item.part.id || item.index}
																		allOpen={allThinkingOpen}
																		epoch={thinkingEpoch}
																		isStreaming={status === "streaming" && mi === messages.length - 1 && item.index === m.parts.length - 1}
																		text={item.part.text ?? ""}
																	/>
																);
															case "object": {
																// One part per object (projectView folds revisions): latest data, first position.
																const { objectId, objectType, rev, data } = item.part as unknown as { objectId: string; objectType: string; rev: number; data: unknown };
																const Card = lookupCard("object", objectType)?.Renderer;
																return Card ? <Card key={`obj-${objectId}`} objectId={objectId} type={objectType} rev={rev} data={data} /> : null;
															}
															case "separator":
																return <Separator key={`sep-${item.index}`} className="my-3" />;
															case "tool":
																return <ToolItemRow key={item.key} item={item} open={runOpen(openRows, item.key)} onOpenChange={setRowOpen(item.key)} cardCtx={cardCtx} />;
															case "group": {
																// A card never hides inside a collapsed group: it renders after the group's plain rows.
																const plain = item.items.filter((t) => !raisesCard(cardCtx, t.entry.callId));
																const raised = item.items.filter((t) => raisesCard(cardCtx, t.entry.callId));
																return (
																	<Fragment key={item.key}>
																		{plain.length > 0 && (
																			<ToolGroup
																				entries={plain.map((t) => t.entry)}
																				open={runOpen(openRows, item.key, item.items[0]!.key)}
																				onOpenChange={setRowOpen(item.key)}
																			>
																				{plain.map((t) => (
																					<ToolItemRow key={t.key} item={t} open={runOpen(openRows, t.key)} onOpenChange={setRowOpen(t.key)} cardCtx={cardCtx} />
																				))}
																			</ToolGroup>
																		)}
																		{raised.map((t) => (
																			<InlineCard key={t.key} callId={t.entry.callId} ctx={cardCtx} />
																		))}
																	</Fragment>
																);
															}
														}
													})}
												</MessageContent>
											</Message>
										)}
									</Fragment>
								))}
								{status === "submitted" && (
									<span className="flex items-center gap-2 font-ui text-xs font-medium uppercase tracking-wide text-muted-foreground">
										<BrailleSpinner label="Thinking" />
										<Shimmer duration={1}>THINKING…</Shimmer>
									</span>
								)}
								{sendPending && !cardError && (
									<div data-testid="card-send-pending" className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
										Will send when the turn finishes.
									</div>
								)}
								{cardError && (
									<div
										data-testid="card-error"
										className="flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
									>
										<span>{cardError}</span>
										<button type="button" onClick={() => setCardError(null)} className="text-xs underline">
											Dismiss
										</button>
									</div>
								)}
								{error && (
									<div
										data-testid="thread-error"
										className="flex items-center justify-between rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
									>
										<span>Something went wrong: {error.message}</span>
										<button type="button" onClick={clearError} className="text-xs underline">
											Dismiss
										</button>
									</div>
								)}
							</div>
							{/* Reserve the composer's height so the tail scrolls clear of it. */}
							<div
								aria-hidden
								data-testid="thread-tail-spacer"
								className={dockHeight === null ? "h-40" : undefined}
								style={dockHeight !== null ? { height: dockHeight } : stripReserve ? { marginTop: stripReserve } : undefined}
							/>
						</ConversationContent>
						<div ref={setDockEl} className="pointer-events-none absolute inset-x-0 bottom-0">
							<div className={ask.covers ? "h-0" : "h-16"} data-testid="dock-fade" style={{ background: `linear-gradient(to top, ${tintSolid}, transparent)` }} />
							<div className="pb-4 max-md:pb-0" style={{ backgroundColor: tintSolid }}>
								<div className={DOCK}>
									<SubagentStrip wolf={wolf} slug={slug} items={subagents} attached={attachedRow} />
									{closedReason !== undefined ? (
										<div data-testid="thread-closed" className="pointer-events-auto rounded-2xl border bg-card px-4 py-3 text-sm shadow-lg">
											<div className="font-medium">{FEATURE_GRADUATED}</div>
											<div className="text-muted-foreground">{closedReason}</div>
											{busy ? (
												<button type="button" data-testid="thread-closed-stop" onClick={onStop} className="mt-2 rounded-md border px-3 py-1 text-sm">
													Stop the running turn
												</button>
											) : null}
										</div>
									) : barOwnsInput ? null : (
									<>
									{ask.sheet}
									{ask.pending && isSupersedable(session.pc) && !noteMode && !ask.composing && text.trim() !== "" && <p data-testid="ask-replace-hint" className="pointer-events-auto px-1 pb-1 font-ui text-xs text-muted-foreground">{session.pc.source?.kind === "tool" ? "Sending a message cancels this confirmation." : "Sending a message replaces the open questions."}</p>}
									{!ask.composing && (
									<div
										data-testid="thread-composer-card"
										data-note-mode={noteMode ? "true" : undefined}
										{...(dictation.active ? { "data-listening": "true" } : {})}
										className={`pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg${noteMode ? " rounded-t-none border-t-0 border-(color:--thread-accent)" : ""}${dictation.active ? " border-transparent ring-2" : dragging ? " ring-2 ring-(color:--thread-accent)" : noteMode ? "" : " focus-within:border-(color:--thread-accent) focus-within:ring-1 focus-within:ring-(color:--thread-accent)"}`}
										style={dictation.active ? ({ "--tw-ring-color": tintHex, boxShadow: `0 0 24px ${tintHex}66` } as CSSProperties) : undefined}
									>
										{noteMode && <p data-testid="ask-armed-live" aria-live="polite" className="sr-only">{session.action.armed ? session.action.ariaLabel : ""}</p>}
										{noteMode && session.action.hint && <p data-testid="ask-missing" role="status" aria-live="polite" className="px-3 pt-2 font-ui text-xs text-muted-foreground">{session.action.hint}</p>}
										{noteMode && session.error && <p role="alert" className="px-3 pt-1 font-ui text-xs text-destructive">{session.error}</p>}
										<Composer
											busy={noteMode ? false : busy}
											value={noteMode ? session.note.text : text}
											onChange={noteMode ? session.setNoteText : applyText}
											onSend={noteMode ? onNoteSend : onSend}
											{...(noteMode ? { sendLabel: session.action.label, alwaysLabel: true, ...(session.action.armed ? { sendAriaLabel: session.action.ariaLabel, armed: { onCancel: session.disarm } } : {}) } : {})}
											onStop={onStop}
											// A live dictation makes an idle composer sendable (chat.tsx), but while a turn runs it must not turn Stop into
											// Send: deviation from chat.tsx, Stop stays available (the tail is sent once text exists).
											canSend={noteMode ? !session.action.disabled : canSendWith(text, attachments) || (dictation.active && !busy)}
											finishing={dictation.phase === "stopping"}
											recording={recordingHere}
											onEscape={dictation.active ? dictation.cancel : undefined}
											// Enter while dictating finishes and steers the spoken text; the button stays Stop.
											enterSends={dictation.active}
											onFiles={noteMode ? session.addNoteFiles : onFiles}
											onPickFiles={noteMode ? session.addNoteFiles : onFiles}
											chips={<AttachmentChips items={noteMode ? session.note.atts : attachments} onRemove={noteMode ? session.removeNoteAtt : removeAttachment} />}
											inputRef={inputRef}
											controls={noteMode ? null : threadSettings.loaded ? <ComposerControls settings={threadSettings.settings} error={threadSettings.error} onChange={(p) => void threadSettings.change(p)} /> : null}
											autoFocus
											placeholder={noteMode ? "Add a note for the agent…" : busy ? "Steer the running turn…" : "Message the wolf…"}
										/>
										{/* Dictation sits under the message field (owner, 2026-10-27). */}
										<div className="px-3 pb-2" data-testid="dictation-slot">
											<DictationBar dictation={dictation} />
										</div>
									</div>
									)}
									</>
									)}
								</div>
							</div>
						</div>
					</Conversation>
					{/* One flex column for everything pinned: checklist / feature progress, then the decision and graph pins. The pins sit below whichever panel is open, at its real height; the column's max height (the thread area minus the composer reserve) caps what is open. */}
					<div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex min-h-0 flex-col" style={{ maxHeight: `max(6rem, calc(100% - ${dockHeight ?? 160}px))` }} data-testid="pinned-column">
						{featureProgress.state.phase === "ready" && (
							<FeatureProgressPanel threadId={threadId} model={featureProgress.state.model} busy={busy} />
						)}
						<PinnedChecklist active={pinned} threadId={threadId} onDismiss={() => inputRef.current?.focus()} />
						<PinnedObjects items={pinnedObjects} threadId={threadId} onDismiss={() => inputRef.current?.focus()} />
					</div>
				</div>
			</div>
			<RightPanelHost />
		</div>
	);
}

/** The nearest scrolling ancestor (the stick-to-bottom viewport). */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
	for (let p = el?.parentElement ?? null; p; p = p.parentElement) {
		const oy = getComputedStyle(p).overflowY;
		if (oy === "auto" || oy === "scroll") return p;
	}
	return null;
}

/** The thread view plus its right-panel host: the provider sits above the view so any child can call openPanel. */
export function ThreadChat(props: ComponentProps<typeof ThreadChatInner>) {
	return (
		<PanelHostProvider wolf={props.wolf} slug={props.slug} threadId={props.threadId}>
			<ThreadChatInner {...props} />
		</PanelHostProvider>
	);
}
