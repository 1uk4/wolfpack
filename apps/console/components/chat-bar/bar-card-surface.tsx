"use client";

/**
 * The floating bar's card surface: the attached thread's pending card (oldest first, "1 of N"), a superseded card for a
 * moment after the owner replied in free text, or else a short peek of the last reply. Self-contained (props in, REST
 * out) so the phone's full-screen sheet can host the same component. The cards render through the shared AskCard,
 * compact; answer / skip POST to the same routes as an inline card.
 */
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "lucide-react";
import { AskCard } from "@/components/ask/ask-card";
import { MessageResponse } from "@/components/ai-elements/message";
import { cardAnswerUrl, cardSkipUrl } from "@/components/thread-transport";
import type { BarCards } from "@/components/chat-bar/chat-bar-cards";
import { threadHref, type AttachedRef } from "@/src/core";
import type { CardAnswers } from "@wolfpack/client";

export function BarCardSurface({ target, cards }: { target: AttachedRef; cards: BarCards }) {
	const router = useRouter();
	const [busy, setBusy] = useState<string | null>(null);
	const keyNow = useRef("");
	keyNow.current = `${target.wolf}:${target.threadId}`;
	const { pending, superseded, peek, error, setError } = cards;
	const openThread = () => router.push(threadHref(target.wolf, target.threadId));

	const resolve = async (callId: string, answers?: CardAnswers) => {
		if (busy) return;
		setBusy(callId);
		setError(null);
		const key = `${target.wolf}:${target.threadId}`;
		try {
			const res = await fetch(answers ? cardAnswerUrl(target.wolf, target.slug, callId) : cardSkipUrl(target.wolf, target.slug, callId), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: answers ? JSON.stringify({ answers }) : undefined,
			});
			if (key !== keyNow.current) return; // the bar moved to another thread meanwhile
			if (res.ok) cards.settle(callId);
			else {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				setError(body?.error ?? `Could not send the ${answers ? "answer" : "skip"} (${res.status}).`);
				if (res.status === 404) cards.refetch();
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not send.");
		} finally {
			setBusy(null);
		}
	};

	const first = pending[0];
	return (
		<>
			{first && (
				<div data-testid="bar-card" data-call-id={first.callId} className="max-h-[60vh] overflow-y-auto rounded-xl bg-card shadow-lg">
					{pending.length > 1 && <div data-testid="bar-card-counter" className="px-3 pt-2 font-ui text-[11px] text-muted-foreground">1 of {pending.length}</div>}
					<AskCard
						key={first.callId}
						callId={first.callId}
						card={first.card}
						{...(first.heldAnswer ? { heldAnswer: first.heldAnswer } : {})}
						{...(first.heldSkip ? { heldSkip: true } : {})}
						pending
						submitting={busy === first.callId}
						compact
						onOpenThread={openThread}
						onAnswer={(a) => void resolve(first.callId, a)}
						onSkip={() => void resolve(first.callId)}
					/>
				</div>
			)}
			{error && <p role="alert" data-testid="bar-card-error" className="rounded-xl border bg-card px-3 py-1.5 font-ui text-xs text-destructive shadow-lg">{error}</p>}
			{!first && superseded.map((s) => (
				<div key={s.callId} data-testid="bar-card-superseded" className="rounded-xl bg-card shadow-lg">
					<AskCard callId={s.callId} card={s.card} closed="superseded" dismissed pending={false} submitting={false} compact onAnswer={() => {}} />
				</div>
			))}
			{!first && superseded.length === 0 && peek && (
				<div data-testid="bar-peek" className="relative rounded-xl border bg-card px-3 py-2 shadow-lg">
					<div data-testid="bar-peek-text" className="relative max-h-[4.5rem] overflow-hidden pr-6 text-sm">
						<MessageResponse>{peek}</MessageResponse>
						<div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-4 bg-gradient-to-t from-card to-transparent" />
					</div>
					<div className="mt-1 flex gap-3 font-ui text-xs">
						<button type="button" data-testid="bar-peek-open" className="text-primary underline" onClick={openThread}>Open thread</button>
					</div>
					<button type="button" aria-label="Dismiss" data-testid="bar-peek-dismiss" onClick={cards.dismissPeek} className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground hover:bg-accent">
						<XIcon className="size-3.5" />
					</button>
				</div>
			)}
		</>
	);
}
