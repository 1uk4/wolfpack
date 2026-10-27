"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellIcon, BellOffIcon, ChevronRightIcon } from "lucide-react";
import { lookupInteractionCard } from "@/components/card-registry";
import { cardAnswerUrl } from "@/components/thread-transport";
import { useServerEvent, useServerResync } from "@/components/server-events";
import {
	browserNotifyEnabled,
	canToggleBrowserNotify,
	deliverNotification,
	setBrowserNotify,
} from "@/components/needs-you-notify";
import { cn } from "@/lib/utils";
import { INITIAL_NOTIFY_STATE, cardHeadline, itemKey, planNotifications, withoutItem, type NeedsYouItem, type NotifyState } from "@/src/core";
import type { CardAnswers } from "@wolfpack/client";

/** "5m" / "3h" / "2d": how long a card has been waiting (compact; the sidebar is narrow). */
export function waitingFor(iso: string, now = new Date()): string {
	const min = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
	if (min < 1) return "now";
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/**
 * The pinned "Needs you" section: the cards waiting for the operator across all wolves, with a count. Clicking a row
 * expands its card inline (the same card component and the same answer route as in the thread); "Open thread" navigates.
 * Presentational: the controller below owns data, answering and notifications. Renders nothing when nothing waits.
 */
export function NeedsYouSection({
	items,
	expandedKey,
	submittingKey,
	error,
	now,
	notifyToggle,
	onToggle,
	onAnswer,
	onOpen,
	onToggleNotify,
}: {
	items: readonly NeedsYouItem[];
	expandedKey: string | null;
	submittingKey?: string | null;
	error?: string | null;
	now?: Date;
	/** Browser only: undefined hides the bell, otherwise whether notifications are on. */
	notifyToggle?: boolean;
	onToggle(key: string): void;
	onAnswer(item: NeedsYouItem, answers: CardAnswers): void;
	onOpen(item: NeedsYouItem): void;
	onToggleNotify?(): void;
}) {
	if (items.length === 0) return null;
	return (
		<section className="mx-3 mb-2 rounded-lg border bg-card/50 p-1.5" data-testid="needs-you" aria-label="Needs you">
			<div className="mb-1 flex items-center gap-2 px-1.5 pt-0.5">
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Needs you</span>
				<span
					data-testid="needs-you-count"
					className="rounded-full bg-primary px-1.5 text-[10px] font-medium leading-4 text-primary-foreground"
					aria-label={`${items.length} waiting`}
				>
					{items.length}
				</span>
				{notifyToggle !== undefined && (
					<button
						type="button"
						data-testid="needs-you-notify-toggle"
						aria-pressed={notifyToggle}
						aria-label={notifyToggle ? "Turn off notifications" : "Notify me when a wolf needs me"}
						title={notifyToggle ? "Notifications on" : "Notify me when a wolf needs me"}
						onClick={onToggleNotify}
						className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						{notifyToggle ? <BellIcon className="size-3" /> : <BellOffIcon className="size-3" />}
					</button>
				)}
			</div>
			<ul className="max-h-[50vh] overflow-y-auto">
				{items.map((item) => {
					const key = itemKey(item);
					const open = key === expandedKey;
					const Card = lookupInteractionCard(item.card.tool)?.Renderer;
					return (
						<li key={key} data-testid="needs-you-item" data-wolf={item.wolf} data-call={item.callId}>
							<button
								type="button"
								data-testid="needs-you-row"
								aria-expanded={open}
								onClick={() => onToggle(key)}
								className="flex w-full items-start gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors hover:bg-accent"
							>
								<ChevronRightIcon className={cn("mt-1 size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
								<span className="min-w-0 flex-1">
									<span className="block truncate text-xs text-muted-foreground">
										{item.wolf} · {item.threadTitle}
									</span>
									<span className="block truncate font-prose text-(length:--lh-prose-size)">{cardHeadline(item.card)}</span>
								</span>
								<span className="shrink-0 text-xs text-muted-foreground" data-testid="needs-you-age">
									{waitingFor(item.raisedAt, now)}
								</span>
							</button>
							{open && (
								<div className="px-1.5 pb-2 pt-1" data-testid="needs-you-card">
									{Card ? (
										<Card
											callId={item.callId}
											card={item.card}
											heldAnswer={item.heldAnswer}
											pending
											submitting={submittingKey === key}
											onAnswer={(answers) => onAnswer(item, answers)}
										/>
									) : null}
									{error && <p className="mt-1 text-xs text-destructive" role="alert">{error}</p>}
									<button
										type="button"
										data-testid="needs-you-open"
										onClick={() => onOpen(item)}
										className="mt-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
									>
										Open thread
									</button>
								</div>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/**
 * The section's controller: fetches /api/needs-you (refetching on every poke from the activity bridge and on
 * reconnect), answers through the thread's own card route, and raises the OS notification when a card newly appears
 * while the window is unfocused (planNotifications). Mounted once, in the sidebar.
 */
export function NeedsYouPanel() {
	const router = useRouter();
	const [items, setItems] = useState<NeedsYouItem[]>([]);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notifyOn, setNotifyOn] = useState<boolean | undefined>(undefined);
	const notifyState = useRef<NotifyState>(INITIAL_NOTIFY_STATE);
	const inFlight = useRef(false);
	const again = useRef(false);
	const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const load = useCallback(async () => {
		if (inFlight.current) {
			again.current = true; // a poke arrived mid-fetch: fetch once more so it is not lost
			return;
		}
		inFlight.current = true;
		try {
			const res = await fetch("/api/needs-you", { cache: "no-store" });
			if (!res.ok) return;
			const { items: next } = (await res.json()) as { items?: NeedsYouItem[] };
			if (!Array.isArray(next)) return;
			setItems(next);
			const plan = planNotifications(notifyState.current, next, { focused: document.hasFocus() });
			notifyState.current = plan.state;
			for (const n of plan.notifications) deliverNotification(n, (href) => router.push(href));
		} catch {
			/* a transient failure keeps the last list; the next poke refetches */
		} finally {
			inFlight.current = false;
			if (again.current) {
				again.current = false;
				void load();
			}
		}
	}, [router]);

	const schedule = useCallback(() => {
		if (debounce.current) clearTimeout(debounce.current);
		debounce.current = setTimeout(() => void load(), 150);
	}, [load]);

	useEffect(() => {
		void load();
		return () => {
			if (debounce.current) clearTimeout(debounce.current);
		};
	}, [load]);
	useServerEvent("needs-you-changed", schedule);
	useServerResync(() => void load());

	useEffect(() => {
		setNotifyOn(canToggleBrowserNotify() ? browserNotifyEnabled() : undefined);
	}, []);
	// Electron: a clicked OS notification focuses the window and asks us to open its thread.
	useEffect(() => window.lh?.onNavigate?.((href) => router.push(href)), [router]);

	const answer = useCallback(
		async (item: NeedsYouItem, answers: CardAnswers) => {
			const key = itemKey(item);
			setSubmitting(key);
			setError(null);
			try {
				const res = await fetch(cardAnswerUrl(item.wolf, item.slug, item.callId), {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ answers }),
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as { error?: string } | null;
					setError(body?.error ?? `Could not send the answer (${res.status}).`);
					if (res.status === 404) void load(); // gone (answered elsewhere / superseded)
					return;
				}
				const ack = (await res.json()) as { disposition?: string };
				// Queued: siblings still wait, the card stays (with its held answer); otherwise it is answered.
				if (ack.disposition !== "queued") {
					setItems((prev) => withoutItem(prev, key));
					setExpanded(null);
				}
				void load();
			} catch (err) {
				setError(err instanceof Error ? err.message : "Could not send the answer.");
			} finally {
				setSubmitting(null);
			}
		},
		[load],
	);

	return (
		<NeedsYouSection
			items={items}
			expandedKey={expanded}
			submittingKey={submitting}
			error={error}
			notifyToggle={notifyOn}
			onToggle={(key) => {
				setError(null);
				setExpanded((cur) => (cur === key ? null : key));
			}}
			onAnswer={(item, answers) => void answer(item, answers)}
			onOpen={(item) => router.push(item.href)}
			onToggleNotify={() => void setBrowserNotify(!notifyOn).then(setNotifyOn)}
		/>
	);
}
