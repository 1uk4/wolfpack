"use client";

import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { ToolGroup, ToolRow } from "@/components/tool-row";
import { lookupCard } from "@/components/card-registry";
import { Separator } from "@/components/ui/separator";
import { MemoryPanel } from "@/components/memory-panel";
import { Composer } from "@/components/composer";
import { useChatSession } from "@/components/session";
import { useAllThinkingToggle } from "@/components/thinking-toggle";
import { threadTransport } from "@/components/thread-transport";
import { TopBar } from "@/components/top-bar";
import { ASSISTANT_CONTENT_CLASS, PROSE_BLOCK_CLASS, renderItems, runOpen, type ArtifactPartProps, type LhMessage, type ToolItem } from "@/src/core";

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

function ToolItemRow({ item, open, onOpenChange }: { item: ToolItem; open: boolean; onOpenChange: (open: boolean) => void }) {
	const Renderer = lookupCard("tool", item.entry.name)?.Renderer;
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
}: {
	wolf: string;
	slug: string;
	/** The client's thread id — the sidebar's key for turn-state patches. */
	threadId: string;
	title: string;
	initialMessages: LhMessage[];
	initiallyInFlight?: boolean;
}) {
	const transport = useMemo(() => threadTransport(wolf, slug), [wolf, slug]);
	const { messages, status, error, send, steer, clearError } = useChatSession({
		chatId: threadId,
		initialMessages,
		initiallyInFlight,
		transport,
	});
	const { allOpen: allThinkingOpen, epoch: thinkingEpoch } = useAllThinkingToggle();
	const [text, setText] = useState("");
	// Expand state of tool rows/groups, keyed by row key (see runOpen): survives a row joining a group.
	const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
	const setRowOpen = useCallback(
		(key: string) => (open: boolean) => setOpenRows((prev) => (prev[key] === open ? prev : { ...prev, [key]: open })),
		[],
	);
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const busy = status === "submitted" || status === "streaming";

	const onSend = useCallback(() => {
		const t = text.trim();
		if (!t) return;
		setText("");
		// A running turn takes the text as a steer; Stop is the abort.
		if (busy) steer(t);
		else send({ type: "text", text: t });
	}, [text, busy, send, steer]);

	const onStop = useCallback(() => {
		void fetch(transport.abortUrl!, { method: "POST" }).catch(() => {
			/* the turn settles on its own */
		});
	}, [transport]);

	return (
		<div className="flex h-dvh" data-testid="thread-chat" data-thread={threadId}>
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
											</div>
										) : (
											<Message from="assistant" className="max-w-full">
												<MessageContent className={ASSISTANT_CONTENT_CLASS}>
													{renderItems(m.parts, status === "streaming" && mi === messages.length - 1).map((item) => {
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
															case "separator":
																return <Separator key={`sep-${item.index}`} className="my-3" />;
															case "tool":
																return <ToolItemRow key={item.key} item={item} open={runOpen(openRows, item.key)} onOpenChange={setRowOpen(item.key)} />;
															case "group":
																return (
																	<ToolGroup
																		key={item.key}
																		entries={item.entries}
																		open={runOpen(openRows, item.key, item.items[0]!.key)}
																		onOpenChange={setRowOpen(item.key)}
																	>
																		{item.items.map((t) => (
																			<ToolItemRow key={t.key} item={t} open={runOpen(openRows, t.key)} onOpenChange={setRowOpen(t.key)} />
																		))}
																	</ToolGroup>
																);
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
									<div className="pointer-events-auto overflow-hidden rounded-2xl border bg-card shadow-lg">
										<Composer
											busy={busy}
											value={text}
											onChange={setText}
											onSend={onSend}
											onStop={onStop}
											canSend={text.trim().length > 0}
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
