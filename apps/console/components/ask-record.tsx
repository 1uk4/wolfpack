"use client";

import { useState } from "react";
import { askRecord, plainAnswer, type AskRecordItem } from "@wolfpack/protocol";
import type { Card, CardAnswers, CardClosed } from "@wolfpack/client";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";
import { escapeRawHtml } from "@/src/core";

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

const HEADER = { answered: "Questions answered", skipped: "Questions skipped", superseded: "Questions replaced by your message", open: "Questions open" } as const;

/** Remote images never load from a question's context: the renderer drops every `img` element (inline, reference-style or raw). */
const NO_IMAGES = ["img"] as const;

function Diagram({ src }: { src: string }) {
	const [failed, setFailed] = useState(false);
	if (failed) return <div data-testid="ask-record-diagram-missing" className="rounded border border-dashed px-2 py-3 text-xs text-muted-foreground">Diagram not available</div>;
	// eslint-disable-next-line @next/next/no-img-element
	return <img src={src} alt="" className="max-h-64 max-w-full rounded border" onError={() => setFailed(true)} />;
}

function Line({ item, card, diagramUrl }: { item: AskRecordItem; card: Card; diagramUrl(id: string): string }) {
	const [open, setOpen] = useState(false);
	const field = card.fields.find((f) => f.id === item.id);
	if (!field) return null;
	const detail = item.context !== undefined || item.diagram !== undefined;
	const answer = item.state === "answered" ? plainAnswer(field, item.answer!) : item.state;
	return (
		<li data-testid="ask-record-line" data-state={item.state} className="py-0.5">
			<div className="flex items-baseline gap-2">
				<span data-testid="ask-record-text" className={cn("min-w-0 flex-1 break-words", item.state !== "answered" && "text-muted-foreground")}>
					{item.ask} → <span className={cn(item.state === "answered" && "font-medium text-foreground")}>{answer}</span>
					{item.draft && <span className="ml-1 text-xs italic text-muted-foreground"> typed, not sent</span>}
				</span>
				{detail && (
					<button type="button" data-testid="ask-record-expand" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
						{open ? "Hide" : "Context"}
					</button>
				)}
			</div>
			{open && (
				<div className="mt-1 flex flex-col gap-2 border-l-2 pl-3 text-xs text-muted-foreground">
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
		<div data-testid="ask-record" data-closed={state} className="rounded-xl border bg-card p-3 text-sm text-card-foreground">
			<div data-testid="ask-record-header" className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
				{HEADER[state]}
			</div>
			<ul className="list-none">
				{rec.items.map((i) => (
					<Line key={i.id} item={i} card={card} diagramUrl={diagramUrl} />
				))}
			</ul>
		</div>
	);
}
