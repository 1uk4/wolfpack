"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { ToolGroup, ToolRow } from "@/components/tool-row";
import { lookupCard, lookupInteractionCard } from "@/components/card-registry";
import { PINNED_CHECKLIST_RESERVE, PinnedChecklist, useChecklistDismissed } from "@/components/pinned-checklist";
import { Separator } from "@/components/ui/separator";
import { SubagentMessage } from "@/components/subagent-message";
import { parseSubagentMessage } from "@/src/core/subagent-message";
import { STRIP_ROW_PX, SubagentStrip, useSubagentChildren } from "@/components/subagent-strip";
import { PanelHostProvider, RightPanelHost } from "@/components/panel-host";
import { AttachmentChips, Composer } from "@/components/composer";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { AttachmentThumbs } from "@/components/attachment-thumbs";
import { canSendWith, chipFor, dragHasFiles, droppedFiles, readyInfos, uploadFile, type AttachmentInfo, type PendingAttachment } from "@/components/attachments";
import { useChatSession } from "@/components/session";
import { useAllThinkingToggle } from "@/components/thinking-toggle";
import { cardAnswerUrl, cardSkipUrl, threadTransport, type ThreadCardEvent } from "@/components/thread-transport";
import { useOptionalServerEvent } from "@/components/server-events";
import { TopBar } from "@/components/top-bar";
import {
	ASSISTANT_CONTENT_CLASS,
	NO_CARDS,
	activeChecklist,
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
} from "@/src/core";
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
function ThreadChatInner({
	wolf,
	slug,
	threadId,
	title,
	initialMessages,
	initiallyInFlight,
	initialCards = NO_CARDS,
}: {
	wolf: string;
	slug: string;
	/** The client's thread id — the sidebar's key for turn-state patches. */
	threadId: string;
	title: string;
	initialMessages: LhMessage[];
	initiallyInFlight?: boolean;
	/** Interaction cards of the thread record (pending ones + the card-raising calls of the history). */
	initialCards?: ThreadCards;
}) {
	// Live card events reach the chat through a ref: the transport is created before the cards state exists.
	const cardEventRef = useRef<(ev: ThreadCardEvent) => void>(() => {});
	const transport = useMemo(() => threadTransport(wolf, slug, (ev) => cardEventRef.current(ev)), [wolf, slug]);
	const { messages, status, error, send, steer, clearError, resumeStream } = useChatSession({
		chatId: threadId,
		initialMessages,
		initiallyInFlight,
		transport,
	});
	const [cards, setCards] = useState<ThreadCards>(initialCards);
	const [answering, setAnswering] = useState<string | null>(null);
	const [cardError, setCardError] = useState<string | null>(null);
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
			if (next) setCards(next);
		} catch {
			/* the next settle refetches */
		}
	}, [transport]);
	// A card raised mid-stream shows at once (no wait for the turn to settle); an answer's text comes with the record.
	useEffect(() => {
		cardEventRef.current = (ev) => {
			cardEpoch.current++;
			setCards((c) => foldCardEvent(c, ev));
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
	const prevStatus = useRef(status);
	useEffect(() => {
		const was = prevStatus.current;
		prevStatus.current = status;
		const wasRunning = was === "submitted" || was === "streaming";
		if (wasRunning && status === "ready") {
			void refreshCards();
			if (busyMissed.current) resumeStream();
		}
		if (status === "ready" || status === "error") busyMissed.current = false;
	}, [status, refreshCards, resumeStream]);
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
				// Otherwise the answer starts the next turn: attach to it.
				if (ack.disposition === "queued") {
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
		[wolf, slug, resumeStream, refreshCards],
	);
	const cardCtx: CardContext = { cards, answering, onAnswer: (callId, answers) => void resolveCard(callId, answers), onSkip: (callId) => void resolveCard(callId) };
	const { allOpen: allThinkingOpen, epoch: thinkingEpoch } = useAllThinkingToggle();
	const [text, setText] = useState("");
	// Ref mirror of the composer text: a dictation flush lands via setState, which a send resuming after
	// `await dictation.finish()` cannot observe in time (same law as chat.tsx).
	const textRef = useRef("");
	const applyText = useCallback((v: string) => {
		textRef.current = v;
		setText(v);
	}, []);
	// Voice dictation: finals append to the composer unless a card field claims the target (see AskCard).
	const dictation = useDictation({ append: (t) => applyText(joinDictation(textRef.current, t)) });
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
	const active = useMemo(() => activeChecklist(messages), [messages]);
	const pinned = useChecklistDismissed(threadId, active?.objectId) ? undefined : active;
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const busy = status === "submitted" || status === "streaming";
	const subagents = useSubagentChildren(wolf, slug, threadId);
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
	const onFiles = useCallback(
		(files: File[]) => {
			for (const file of files) {
				const key = `att-${Math.random().toString(36).slice(2)}`;
				const { chip, upload } = chipFor(file, key);
				setAttachments((prev) => [...prev, chip]);
				if (!upload) continue;
				uploadFile(transport.uploadUrl!, file).then(
					({ id, name, mimeType, size }) => patchAttachment(key, { status: "ready", id, name, mimeType, size }),
					(err: Error) => patchAttachment(key, { status: "error", error: err.message }),
				);
			}
		},
		[transport, patchAttachment],
	);
	const [dragging, setDragging] = useState(false);
	const removeAttachment = useCallback((key: string) => setAttachments((prev) => prev.filter((a) => a.key !== key)), []);

	// A run that ends hands the cursor to the composer, unless a card field holds the dictation target.
	const dictationWasActive = useRef(false);
	useEffect(() => {
		if (dictation.active) dictationWasActive.current = true;
		else if (dictationWasActive.current) {
			dictationWasActive.current = false;
			if (!document.querySelector("[data-dictation-claimed]")) inputRef.current?.focus();
		}
	}, [dictation.active]);

	const doSend = useCallback(() => {
		const t = textRef.current.trim();
		if (!canSendWith(t, attachments)) return;
		const refs = readyInfos(attachments);
		applyText("");
		setAttachments((prev) => prev.filter((a) => a.status === "uploading"));
		// A running turn takes the message as a steer, attachments included (the submit route accepts them with
		// whenBusy "steer"); Stop is the abort.
		if (busy) return steer(t, refs);
		send({ type: "text", text: t, ...(refs.length ? { attachments: refs } : {}) });
	}, [busy, send, steer, attachments, applyText]);
	// Finish a live dictation first: the spoken tail must be in the message. One send in flight at a time (a second
	// Enter/click during the finish must not send twice); doSend runs through a ref so it sees the settled state, and
	// does nothing (composer untouched) when the finish left no text and no ready attachment.
	const doSendRef = useRef(doSend);
	doSendRef.current = doSend;
	const sendInFlight = useRef(false);
	const onSend = useCallback(() => {
		if (sendInFlight.current) return;
		if (!dictation.active) return doSend();
		sendInFlight.current = true;
		void dictation.finish().then(() => {
			sendInFlight.current = false;
			doSendRef.current();
		});
	}, [dictation, doSend]);

	const onStop = useCallback(() => {
		void fetch(transport.abortUrl!, { method: "POST" }).catch(() => {
			/* the turn settles on its own */
		});
	}, [transport]);

	return (
		<div
			className="flex h-dvh"
			data-testid="thread-chat"
			data-thread={threadId}
			data-dragging={dragging || undefined}
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
				onFiles(droppedFiles(e.dataTransfer));
			}}
		>
			<div className="flex min-w-0 flex-1 flex-col">
				<TopBar>
					<span className="min-w-4 shrink truncate font-title text-3xl tracking-tight">{title}</span>
					<span className="text-xs uppercase tracking-wide text-muted-foreground">{wolf}</span>
				</TopBar>
				<div className="relative flex min-h-0 flex-1">
					<Conversation className="h-full min-w-0 flex-1" initial="instant">
						<ConversationContent className="min-h-full gap-0 p-0">
							<div className={`${COLUMN} flex flex-1 flex-col gap-4 ${pinned ? PINNED_CHECKLIST_RESERVE : "pt-4"}`}>
								{messages.length === 0 && !busy && (
									<ConversationEmptyState title={title} description="Say something to start a turn." />
								)}
								{messages.map((m, mi) => (
									<Fragment key={m.id || `m-${mi}`}>
										{m.role === "user" && subagentOrigins[mi] ? (
											<SubagentMessage origin={subagentOrigins[mi]!} children={subagents} wolf={wolf} />
										) : m.role === "user" ? (
											<div
												data-testid="user-message"
												className="my-2 w-full border-l-[calc(3ch-14px)] border-muted-foreground/30 bg-card py-1 pl-[14px] pr-4 font-ui text-xs"
											>
												<div className="font-medium uppercase tracking-wide text-muted-foreground">You</div>
												<div className="lh-prose whitespace-pre-wrap text-foreground">
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
							<div aria-hidden className="h-40" style={subagents.length ? { marginTop: Math.min(subagents.length, 4) * STRIP_ROW_PX + 8 } : undefined} />
						</ConversationContent>
						<div className="pointer-events-none absolute inset-x-0 bottom-0">
							<div className="h-16 bg-gradient-to-t from-background to-transparent" />
							<div className="bg-background pb-4">
								<div className={DOCK}>
									<SubagentStrip wolf={wolf} slug={slug} items={subagents} />
									<div className={`pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg${dragging ? " ring-2 ring-primary" : ""}`}>
										<Composer
											busy={busy}
											value={text}
											onChange={applyText}
											onSend={onSend}
											onStop={onStop}
											// A live dictation makes an idle composer sendable (chat.tsx), but while a turn runs it must not turn Stop into
											// Send: deviation from chat.tsx, Stop stays available (the tail is sent once text exists).
											canSend={canSendWith(text, attachments) || (dictation.active && !busy)}
											onEscape={dictation.active ? dictation.cancel : undefined}
											// Enter while dictating finishes and steers the spoken text; the button stays Stop.
											enterSends={dictation.active}
											onFiles={onFiles}
											onPickFiles={onFiles}
											chips={<AttachmentChips items={attachments} onRemove={removeAttachment} />}
											inputRef={inputRef}
											autoFocus
											placeholder={busy ? "Steer the running turn…" : "Message the wolf…"}
										/>
										{/* Dictation sits under the message field (owner, 2026-10-27). */}
										<div className="px-3 pb-2" data-testid="dictation-slot">
											<DictationBar dictation={dictation} />
										</div>
									</div>
								</div>
							</div>
						</div>
					</Conversation>
					<PinnedChecklist active={pinned} threadId={threadId} onDismiss={() => inputRef.current?.focus()} />
				</div>
			</div>
			<RightPanelHost />
		</div>
	);
}

/** The thread view plus its right-panel host: the provider sits above the view so any child can call openPanel. */
export function ThreadChat(props: ComponentProps<typeof ThreadChatInner>) {
	return (
		<PanelHostProvider wolf={props.wolf} threadId={props.threadId}>
			<ThreadChatInner {...props} />
		</PanelHostProvider>
	);
}
