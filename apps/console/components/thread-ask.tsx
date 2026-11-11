"use client";

/**
 * The questionnaire sheet on the thread's OWN page (work-wolfpack-ssPFrEw). The floating bar never mounts there (the page
 * composer is the input), so the page hosts the sheet itself: the pending paged `ask` card is read over REST like the bar
 * does, shown as ONE card with the page composer on a wide screen and as a full-screen layer sitting on the composer on a phone.
 * While the sheet is expanded the page composer is the note's (see ask-session.ts): its button reads Next / Submit and the
 * model and Auto-ship controls are hidden. "Answering Qn" is the inline composer's: its text goes to the question, not to the chat.
 */
import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useBarCards } from "@/components/chat-bar/chat-bar-cards";
import { useWide } from "@/components/chat-bar/chat-bar";
import { askQueue, useAskQueue, useAskSession, type AskSession, type NoteState } from "@/components/ask/ask-session";
import type { Answering } from "@/components/ask/ask-sheet";
import type { Dictation } from "@/components/composer/dictation";
import { BAR_EXTRAS, type AttachedRef } from "@/src/core";

const AskSheet = dynamic(() => import("@/components/ask/ask-sheet").then((m) => m.AskSheet), { ssr: false });

export interface OwnAsk {
	/** The sheet (or, on a phone with the sheet put away, the strip that reopens it); null with no pending paged card. */
	sheet: React.ReactNode;
	/** A paged ask is pending. */
	pending: boolean;
	/** A question is being answered in the sheet's inline composer: the page composer is hidden meanwhile. */
	composing: boolean;
	/** The phone's full-screen layer is open above the dock: the dock drops its fade strip so the layer sits right on the composer. */
	covers?: boolean;
	/** The session; the page composer is the note's while `session.active && session.expanded && !composing && sheetShown`. */
	session: AskSession;
	/** The sheet is on screen (wide, or open on a phone): the composer is then Next / Submit. */
	sheetShown: boolean;
	/** Drop the card at once (it was superseded by a message sent from the composer). */
	settle: () => void;
}

export function useOwnAsk(target: AttachedRef, working: boolean, dockHeight: number | null, dictation: Dictation, onCollapse?: (n: NoteState) => void): OwnAsk {
	const wide = useWide();
	const cards = useBarCards(target, working, BAR_EXTRAS.ask);
	const queue = useAskQueue(BAR_EXTRAS.ask ? askQueue(cards.pending) : []);
	const pc = queue.current;
	const session = useAskSession(target, pc, { onSubmitted: (id) => cards.settle(id), queued: queue.ids, onRefetch: cards.refetch, onCollapse });
	const [answering, setAnswering] = useState<Answering | null>(null);
	const [open, setOpen] = useState(true);
	const callId = pc?.callId;
	useEffect(() => setOpen(true), [callId]);
	const composing = !!answering && !!pc && pc.callId === answering.callId && (pc.card.steps?.[session.page]?.fields ?? []).includes(answering.qid);
	useEffect(() => {
		if (answering && !composing) setAnswering(null); // its question left the page
	}, [answering, composing]);
	const settle = () => cards.replied();
	if (!pc) return { pending: false, sheet: null, composing: false, session, sheetShown: false, settle };
	const sheet = <AskSheet key={pc.callId} target={target} session={session} queue={queue} answering={answering} setAnswering={setAnswering} dictation={dictation} />;
	if (!session.expanded) {
		// Collapsed: a strip on top of the normal composer (tap to expand again).
		return { pending: true, sheet: <ExpandStrip count={queue.count} onClick={() => session.setExpanded(true)} />, composing: false, session, sheetShown: false, settle };
	}
	if (wide) {
		return { pending: true, sheet: <div data-testid="ask-sheet-host" data-layout="inline" data-composing={composing ? "true" : undefined} className={`pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-t-2xl border border-b-0 ${composing ? "" : "border-(color:--thread-accent) "}bg-card shadow-lg ${composing ? "max-h-[80vh]" : "max-h-[60vh]"}`}>{sheet}</div>, composing, session, sheetShown: true, settle };
	}
	if (!open) {
		return { pending: true, sheet: <ExpandStrip count={queue.count} onClick={() => setOpen(true)} />, composing, session, sheetShown: false, settle };
	}
	// A phone: the sheet covers the screen down to the composer's dock. Its bottom follows the dock's live (ResizeObserver) height, so the composer stays reachable.
	// Unverified: with the soft keyboard open on iOS (visualViewport shrinks, layout does not) the dock may sit under the keyboard; this page does not track visualViewport.
	return {
		pending: true,
		sheet: (
			<div data-testid="ask-sheet-host" data-layout="fullscreen" data-composing={composing ? "true" : undefined} role="dialog" aria-modal="false" aria-label="Questions" onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); setOpen(false); } }} className="pointer-events-auto flex min-h-0 flex-col">
				<button type="button" aria-label="Put the questions away" data-testid="ask-sheet-close" onClick={() => setOpen(false)} className="flex min-h-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
					<ChevronDownIcon aria-hidden className="size-5" />
				</button>
				<div className={`flex min-h-0 flex-col overflow-hidden rounded-t-2xl border border-b-0 bg-card${composing ? "" : " border-(color:--thread-accent)"}`}>{sheet}</div>
			</div>
		),
		composing,
		covers: !composing,
		session,
		sheetShown: true,
		settle,
	};
}

function ExpandStrip({ onClick, count }: { onClick: () => void; count: number }) {
	return (
		<button type="button" data-testid="ask-sheet-reopen" onClick={onClick} className="pointer-events-auto flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-l-2 border-l-(color:--thread-accent) bg-card px-3 text-left font-ui text-xs shadow-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
			<span className="font-medium text-foreground">{count >= 2 ? `Questions waiting (${count})` : "Questions waiting"}</span>
			<ChevronUpIcon aria-hidden className="size-4 text-muted-foreground" />
		</button>
	);
}
