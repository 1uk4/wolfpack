"use client";

import { useState } from "react";
import { CheckIcon, ChevronDownIcon, CircleDashedIcon, MessageSquareReplyIcon, SkipForwardIcon } from "lucide-react";
import { askRecord, plainAnswer, type AskRecordItem } from "@wolfpack/protocol";
import type { Card, CardAnswers, CardClosed } from "@wolfpack/client";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { escapeRawHtml } from "@/src/core";
import { imagesOf, withImages } from "@/components/ask-images";

export interface AskRecordProps {
	callId: string;
	card: Card;
	/** How the set ended; absent while it is still open. */
	closed?: CardClosed;
	dismissed?: boolean;
	/** The last page's answers (set with `closed: "answered"`); merged over the earlier pages' answers. */
	answer?: CardAnswers;
	pageAnswers?: CardAnswers;
	pagesDone?: number;
	/** Text typed for the open page and never submitted. */
	draft?: CardAnswers;
	pending: boolean;
	/** URL of a question's diagram: always the console's relay, never built from the id by the renderer. */
	diagramUrl(diagramId: string): string;
}

const BADGE_ICON = { answered: CheckIcon, skipped: SkipForwardIcon, superseded: MessageSquareReplyIcon, open: CircleDashedIcon } as const;
const BADGE_TEXT = { answered: "answered", skipped: "skipped", superseded: "replaced", open: "open" } as const;

const HEADER = { answered: "Questions answered", skipped: "Questions skipped", superseded: "Questions replaced by your message", open: "Questions open" } as const;

/** Remote images never load from a question's context: the renderer drops every `img` element (inline, reference-style or raw). */
const NO_IMAGES = ["img"] as const;

function Diagram({ src }: { src: string }) {
	const [failed, setFailed] = useState(false);
	if (failed) return <div data-testid="ask-record-diagram-missing" className="rounded-xl border border-dashed px-2 py-3 text-xs text-muted-foreground">Diagram not available</div>;
	// eslint-disable-next-line @next/next/no-img-element
	return <img src={src} alt="" className="max-h-64 max-w-full rounded-xl border" onError={() => setFailed(true)} />;
}

function Line({ item, card, diagramUrl }: { item: AskRecordItem; card: Card; diagramUrl(id: string): string }) {
	const [open, setOpen] = useState(false);
	const field = card.fields.find((f) => f.id === item.id);
	if (!field) return null;
	const detail = item.context !== undefined || item.diagram !== undefined;
	const imgs = imagesOf(item.answer).length;
	const imgNote = imgs > 0 ? `${imgs} image${imgs === 1 ? "" : "s"}` : "";
	const text = item.state === "answered" ? plainAnswer(field, withImages(item.answer!, []) as NonNullable<typeof item.answer>) : item.state;
	const answer = imgNote ? (text === "" ? imgNote : `${text} · ${imgNote}`) : text;
	return (
		<li data-testid="ask-record-line" data-state={item.state} className="py-2 first:pt-0 last:pb-0">
			<div className="flex items-start gap-2">
				<span data-testid="ask-record-text" className="flex min-w-0 flex-1 flex-col gap-0.5 [overflow-wrap:anywhere]">
					<span className="text-xs text-muted-foreground">{item.ask}</span>{" "}
					<span className={cn("text-sm", item.state === "answered" ? "font-medium text-foreground" : "text-muted-foreground")}>
						<span aria-hidden className="mr-1.5 text-muted-foreground">→</span>{" "}{answer}
						{item.draft && <span className="ml-1 text-xs italic text-muted-foreground"> typed, not sent</span>}
					</span>
				</span>
				{detail && (
					<button type="button" data-testid="ask-record-expand" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex shrink-0 items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
						{open ? "Hide" : "Context"}
						<ChevronDownIcon aria-hidden className={cn("size-3 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
					</button>
				)}
			</div>
			{open && (
				<div className="mt-1 flex flex-col gap-2 border-l-2 border-l-(color:--thread-accent)/40 pl-3 text-xs text-muted-foreground">
					{item.context !== undefined && <MessageResponse disallowedElements={NO_IMAGES}>{escapeRawHtml(item.context)}</MessageResponse>}
					{item.diagram !== undefined && <Diagram src={diagramUrl(item.diagram)} />}
				</div>
			)}
		</li>
	);
}

/** The transcript's compact record of a paged `ask`: one "Q → A" line per question under a header saying how it ended. */
export function AskRecordCard({ card, closed, dismissed, answer, pageAnswers, pagesDone = 0, draft, pending, diagramUrl }: AskRecordProps) {
	const how = closed ?? (answer ? "answered" : dismissed ? "superseded" : undefined);
	const answers = answer || pageAnswers ? { ...pageAnswers, ...answer } : undefined;
	const rec = askRecord(card, answers, how === "answered" ? card.steps!.length : pagesDone, how === "skipped" ? undefined : how, draft);
	const state = how === "skipped" ? "skipped" : how === "answered" || how === "superseded" ? how : "open";
	return (
		<div data-testid="ask-record" data-closed={state} className="wp-card-enter rounded-xl border border-l-2 border-l-(color:--thread-accent) bg-card p-3 text-sm text-card-foreground shadow-sm">
			<div className="mb-2 flex items-center justify-between gap-2">
				<div data-testid="ask-record-header" className="min-w-0 truncate text-xs font-medium uppercase tracking-wider text-muted-foreground">{HEADER[state]}</div>
				<span aria-hidden className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 font-ui text-[10px] uppercase tracking-wider", state === "answered" ? "bg-primary/10 text-primary" : "bg-accent text-muted-foreground")}>
					{(() => { const I = BADGE_ICON[state]; return <I className="size-3" />; })()}
					{BADGE_TEXT[state]}
				</span>
			</div>
			<ul className="list-none divide-y divide-border/60">
				{rec.items.map((i) => (
					<Line key={i.id} item={i} card={card} diagramUrl={diagramUrl} />
				))}
			</ul>
		</div>
	);
}
