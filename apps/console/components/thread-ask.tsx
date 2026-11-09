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
import { cardTextUrl } from "@/components/thread-transport";
import type { Answering } from "@/components/ask-sheet";
import { replyLabel } from "@/components/ask-reply";
import { BAR_EXTRAS, type AttachedRef } from "@/src/core";

const AskSheet = dynamic(() => import("@/components/ask-sheet").then((m) => m.AskSheet), { ssr: false });

export interface OwnAsk {
	/** The sheet (or, on a phone with the sheet put away, the strip that reopens it); null with no pending paged card. */
	sheet: React.ReactNode;
	/** A paged ask is pending. */
	pending: boolean;
	/** The short label of the question the composer is aimed at (reply mode), else null. */
	answeringLabel: string | null;
	clearAnswering: () => void;
	/** Send the composer text to the aimed question. Resolves to an error message, or null when it was saved. */
	bindText: (text: string) => Promise<string | null>;
}

export function useOwnAsk(target: AttachedRef, working: boolean, dockHeight: number | null): OwnAsk {
	const wide = useWide();
	const cards = useBarCards(target, working, BAR_EXTRAS.ask);
	const pc = BAR_EXTRAS.ask ? cards.pending.find((p) => p.card.paged === true) : undefined;
	const [answering, setAnswering] = useState<Answering | null>(null);
	const [open, setOpen] = useState(true);
	const callId = pc?.callId;
	useEffect(() => setOpen(true), [callId]);
	const label = (() => {
		if (!answering || !pc || pc.callId !== answering.callId) return null;
		const i = pc.card.fields.findIndex((f) => f.id === answering.qid);
		return i < 0 || !(pc.card.steps?.[pc.pageIndex ?? 0]?.fields ?? []).includes(answering.qid) ? null : replyLabel(pc.card.fields[i]!);
	})();
	useEffect(() => {
		if (answering && !label) setAnswering(null); // its question left the page
	}, [answering, label]);
	const clearAnswering = useCallback(() => setAnswering(null), []);
	const bindText = useCallback(
		async (text: string): Promise<string | null> => {
			if (!answering) return "Pick a question first.";
			try {
				const res = await fetch(cardTextUrl(target.wolf, target.slug, answering.callId, answering.qid), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
				if (res.ok) {
					setAnswering(null);
					cards.refetch();
					return null;
				}
				const b = (await res.json().catch(() => null)) as { error?: string } | null;
				return b?.error ?? "Could not save the answer.";
			} catch {
				return "Could not save the answer.";
			}
		},
		[answering, target.wolf, target.slug, cards.refetch], // eslint-disable-line react-hooks/exhaustive-deps
	);
	if (!pc) return { pending: false, sheet: null, answeringLabel: null, clearAnswering, bindText };
	const sheet = (
		<AskSheet key={pc.callId} target={target} pc={pc} answering={answering} setAnswering={setAnswering} onSubmitted={(last) => (last ? cards.settle(pc.callId) : cards.refetch())} onRefetch={cards.refetch} />
	);
	if (wide) {
		return { pending: true, sheet: <div data-testid="ask-sheet-host" data-layout="inline" className="pointer-events-auto flex max-h-[60vh] min-h-0 flex-col">{sheet}</div>, answeringLabel: label, clearAnswering, bindText };
	}
	if (!open) {
		return {
			pending: true,
			sheet: (
				<button type="button" data-testid="ask-sheet-reopen" onClick={() => setOpen(true)} className="pointer-events-auto flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border bg-card px-3 text-left font-ui text-sm shadow-lg">
					<span>Questions waiting</span>
					<ChevronUpIcon className="size-4" />
				</button>
			),
			answeringLabel: label,
			clearAnswering,
			bindText,
		};
	}
	// A phone: the sheet covers the screen down to the composer's dock. Its bottom follows the dock's live (ResizeObserver) height, so the composer stays reachable.
	// Unverified: with the soft keyboard open on iOS (visualViewport shrinks, layout does not) the dock may sit under the keyboard; this page does not track visualViewport.
	return {
		pending: true,
		sheet: (
			<div data-testid="ask-sheet-host" data-layout="fullscreen" role="dialog" aria-modal="false" aria-label="Questions" onKeyDown={(e) => { if (e.key === "Escape" && !e.defaultPrevented) { e.stopPropagation(); setOpen(false); } }} className="pointer-events-auto fixed inset-x-0 top-0 z-40 flex flex-col gap-1 bg-background p-2" style={{ bottom: dockHeight ?? 160 }}>
				<button type="button" aria-label="Put the questions away" data-testid="ask-sheet-close" onClick={() => setOpen(false)} className="flex min-h-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent">
					<ChevronDownIcon className="size-5" />
				</button>
				{sheet}
			</div>
		),
		answeringLabel: label,
		clearAnswering,
		bindText,
	};
}
