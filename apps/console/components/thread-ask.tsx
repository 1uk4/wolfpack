"use client";

/**
 * The questionnaire sheet on the thread's OWN page (work-wolfpack-ssPFrEw). The floating bar never mounts there (the page
 * composer is the input), so the page hosts the sheet itself: the pending paged `ask` card is read over REST like the bar
 * does, shown above the page composer on a wide screen and as a full-screen layer (composer kept below it) on a phone,
 * opening by itself. "Answering Qn" is the page composer's: its text goes to the question, not to the chat.
 */
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useBarCards } from "@/components/chat-bar-cards";
import { useWide } from "@/components/chat-bar";
import type { Answering } from "@/components/ask-sheet";
import type { Dictation } from "@/components/dictation";
import { BAR_EXTRAS, type AttachedRef } from "@/src/core";

const AskSheet = dynamic(() => import("@/components/ask-sheet").then((m) => m.AskSheet), { ssr: false });

export interface OwnAsk {
	/** The sheet (or, on a phone with the sheet put away, the strip that reopens it); null with no pending paged card. */
	sheet: React.ReactNode;
	/** A paged ask is pending. */
	pending: boolean;
	/** A question is being answered in the sheet's inline composer: the page composer is hidden meanwhile. */
	composing: boolean;
}

export function useOwnAsk(target: AttachedRef, working: boolean, dockHeight: number | null, dictation: Dictation): OwnAsk {
	const wide = useWide();
	const cards = useBarCards(target, working, BAR_EXTRAS.ask);
	const pc = BAR_EXTRAS.ask ? cards.pending.find((p) => p.card.paged === true) : undefined;
	const [answering, setAnswering] = useState<Answering | null>(null);
	const [open, setOpen] = useState(true);
	const callId = pc?.callId;
	useEffect(() => setOpen(true), [callId]);
	const composing = !!answering && !!pc && pc.callId === answering.callId && (pc.card.steps?.[pc.pageIndex ?? 0]?.fields ?? []).includes(answering.qid);
	useEffect(() => {
		if (answering && !composing) setAnswering(null); // its question left the page
	}, [answering, composing]);
	if (!pc) return { pending: false, sheet: null, composing: false };
	const sheet = (
		<AskSheet key={pc.callId} target={target} pc={pc} answering={answering} setAnswering={setAnswering} onSubmitted={(last) => (last ? cards.settle(pc.callId) : cards.refetch())} onRefetch={cards.refetch} dictation={dictation} />
	);
	if (wide) {
		return { pending: true, sheet: <div data-testid="ask-sheet-host" data-layout="inline" className={`pointer-events-auto flex min-h-0 flex-col ${composing ? "max-h-[80vh]" : "max-h-[60vh]"}`}>{sheet}</div>, composing };
	}
	if (!open) {
		return {
			pending: true,
			sheet: (
				<button type="button" data-testid="ask-sheet-reopen" onClick={() => setOpen(true)} className="pointer-events-auto flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-l-2 border-l-(color:--thread-accent) bg-card px-3 text-left font-ui text-xs shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
					<span className="font-medium text-foreground">Questions waiting</span>
					<ChevronUpIcon aria-hidden className="size-4 text-muted-foreground" />
				</button>
			),
			composing,
		};
	}
	// A phone: the sheet covers the screen down to the composer's dock. Its bottom follows the dock's live (ResizeObserver) height, so the composer stays reachable.
	// Unverified: with the soft keyboard open on iOS (visualViewport shrinks, layout does not) the dock may sit under the keyboard; this page does not track visualViewport.
	return {
		pending: true,
		sheet: (
			<div data-testid="ask-sheet-host" data-layout="fullscreen" role="dialog" aria-modal="false" aria-label="Questions" onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); setOpen(false); } }} className="pointer-events-auto fixed inset-x-0 top-0 z-40 flex flex-col bg-background px-1.5 pb-1.5 pt-1" style={{ bottom: composing ? 0 : (dockHeight ?? 160) }}>
				<button type="button" aria-label="Put the questions away" data-testid="ask-sheet-close" onClick={() => setOpen(false)} className="flex min-h-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
					<ChevronDownIcon aria-hidden className="size-5" />
				</button>
				{sheet}
			</div>
		),
		composing,
	};
}
