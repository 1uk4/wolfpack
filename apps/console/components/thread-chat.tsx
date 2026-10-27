"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { ToolGroup, ToolRow } from "@/components/tool-row";
import { lookupCard, lookupInteractionCard } from "@/components/card-registry";
import { Separator } from "@/components/ui/separator";
import { MemoryPanel } from "@/components/memory-panel";
import { AttachmentChips, Composer } from "@/components/composer";
import { DictationBar, joinDictation, useDictation } from "@/components/dictation";
import { AttachmentThumbs } from "@/components/attachment-thumbs";
import { canSendWith, chipFor, dragHasFiles, droppedFiles, readyInfos, uploadFile, type AttachmentInfo, type PendingAttachment } from "@/components/attachments";
import { useChatSession } from "@/components/session";
import { useAllThinkingToggle } from "@/components/thinking-toggle";
import { cardAnswerUrl, threadTransport } from "@/components/thread-transport";
import { TopBar } from "@/components/top-bar";
import {
	ASSISTANT_CONTENT_CLASS,
	NO_CARDS,
	PROSE_BLOCK_CLASS,
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
			heldAnswer={call.heldAnswer}
			pending={ctx.cards.pending.some((p) => p.callId === callId)}
			submitting={ctx.answering === callId}
			onAnswer={(answers) => ctx.onAnswer(callId, answers)}
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
export function ThreadChat({
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
	const transport = useMemo(() => threadTransport(wolf, slug), [wolf, slug]);
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
	const refreshCards = useCallback(async () => {
		try {
			const res = await fetch(transport.recordUrl);
			if (!res.ok) return;
			const next = parseThreadCards(await res.json());
			if (next) setCards(next);
		} catch {
			/* the next settle refetches */
		}
	}, [transport]);
	const prevStatus = useRef(status);
	useEffect(() => {
		const was = prevStatus.current;
		prevStatus.current = status;
		const wasRunning = was === "submitted" || was === "streaming";
		if (wasRunning && status === "ready") void refreshCards();
	}, [status, refreshCards]);
	const onAnswer = useCallback(
		async (callId: string, answers: CardAnswers) => {
			setAnswering(callId);
			setCardError(null);
			try {
				const res = await fetch(cardAnswerUrl(wolf, slug, callId), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ answers }),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					setCardError(body?.error ?? `Could not send the answer (${res.status}).`);
					// 404: the card is gone (superseded or answered elsewhere): show the thread as it is now.
					if (res.status === 404) void refreshCards();
					return;
				}
				const ack = (await res.json()) as { disposition?: string };
				// Queued = sibling cards still wait: the wolf holds the answer and the card stays changeable.
				// Otherwise the answer starts the next turn: attach to it.
				if (ack.disposition === "queued") {
					setCards((c) => withHeld(c, callId, answers));
					void refreshCards();
				} else {
					setCards((c) => withAnswer(c, callId, answers));
					resumeStream();
				}
			} catch (err) {
				setCardError(err instanceof Error ? err.message : "Could not send the answer.");
			} finally {
				setAnswering(null);
			}
		},
		[wolf, slug, resumeStream, refreshCards],
	);
	const cardCtx: CardContext = { cards, answering, onAnswer: (callId, answers) => void onAnswer(callId, answers) };
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
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const busy = status === "submitted" || status === "streaming";

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
	// Finish a live dictation first: the spoken tail must be in the message.
	const onSend = useCallback(() => {
		if (!dictation.active) return doSend();
		void dictation.finish().then(doSend);
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
							<div className={`${COLUMN} flex flex-1 flex-col gap-4 pt-4`}>
								{messages.length === 0 && !busy && (
									<ConversationEmptyState title={title} description="Say something to start a turn." />
								)}
								{messages.map((m, mi) => (
									<Fragment key={m.id || `m-${mi}`}>
										{m.role === "user" ? (
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
							<div aria-hidden className="h-40" />
						</ConversationContent>
						<div className="pointer-events-none absolute inset-x-0 bottom-0">
							<div className="h-16 bg-gradient-to-t from-background to-transparent" />
							<div className="bg-background pb-4">
								<div className={DOCK}>
									<div className={`pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg${dragging ? " ring-2 ring-primary" : ""}`}>
										<div className="px-3 pt-2" data-testid="dictation-slot">
											<DictationBar dictation={dictation} />
										</div>
										<Composer
											busy={busy}
											value={text}
											onChange={applyText}
											onSend={onSend}
											onStop={onStop}
											canSend={canSendWith(text, attachments) || dictation.active}
											onEscape={dictation.active ? dictation.cancel : undefined}
											onFiles={onFiles}
											onPickFiles={onFiles}
											chips={<AttachmentChips items={attachments} onRemove={removeAttachment} />}
											inputRef={inputRef}
											autoFocus
											placeholder={busy ? "Steer the running turn…" : "Message the wolf…"}
										/>
									</div>
								</div>
							</div>
						</div>
					</Conversation>
				</div>
			</div>
			<MemoryPanel wolf={wolf} threadId={threadId} />
		</div>
	);
}
