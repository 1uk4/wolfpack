"use client";

import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { Conversation, ConversationContent, ConversationEmptyState } from "@/components/ai-elements/conversation";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import { LiveToolCard } from "@/components/artifacts/live-tool-card";
import { artifactRenderers } from "@/components/artifacts";
import { Separator } from "@/components/ui/separator";
import { Composer } from "@/components/composer";
import { useChatSession } from "@/components/session";
import { threadTransport } from "@/components/thread-transport";
import { TopBar } from "@/components/top-bar";
import type { ArtifactPartProps, LhMessage } from "@/src/core";

const COLUMN = "mx-auto w-full max-w-none px-6";
const DOCK = "mx-auto w-full max-w-[46rem] px-4";

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
	const { messages, status, error, send, clearError } = useChatSession({
		chatId: threadId,
		initialMessages,
		initiallyInFlight,
		transport,
	});
	const [text, setText] = useState("");
	const inputRef = useRef<HTMLTextAreaElement | null>(null);
	const busy = status === "submitted" || status === "streaming";

	const onSend = useCallback(() => {
		const t = text.trim();
		if (!t || busy) return;
		setText("");
		send({ type: "text", text: t });
	}, [text, busy, send]);

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
												<MessageContent className="w-full">
													{m.parts.map((part, pi) => {
														const isLastPart = mi === messages.length - 1 && pi === m.parts.length - 1;
														switch (part.type) {
															case "text":
																return (
																	<div key={part.id || pi}>
																		<MessageResponse>{part.text}</MessageResponse>
																	</div>
																);
															case "reasoning":
																return (
																	<Reasoning
																		key={pi}
																		isStreaming={status === "streaming" && isLastPart}
																		className="mb-2"
																	>
																		<ReasoningTrigger />
																		<ReasoningContent>{part.text ?? ""}</ReasoningContent>
																	</Reasoning>
																);
															case "step-start":
																return pi > 0 ? <Separator key={pi} className="my-3" /> : null;
															default: {
																if (!part.type.startsWith("tool-")) return null;
																const p = part as ArtifactPartProps["part"];
																// Calls being run render the live card; settled
																// ones go through the artifact registry.
																if (part.state === "input-streaming") return <LiveToolCard key={pi} part={p} />;
																const Renderer = artifactRenderers[part.type.slice("tool-".length)];
																return Renderer ? <Renderer key={pi} part={p} /> : null;
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
											// While a turn runs the composer is Stop-only: the
											// client's default whenBusy=reject has no steer.
											canSend={!busy && text.trim().length > 0}
											inputRef={inputRef}
											autoFocus
											placeholder="Message the wolf…"
										/>
									</div>
								</div>
							</div>
						</div>
					</Conversation>
				</div>
			</div>
		</div>
	);
}
