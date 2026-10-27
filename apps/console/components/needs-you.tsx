"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellIcon, BellOffIcon, ChevronRightIcon } from "lucide-react";
import { lookupInteractionCard } from "@/components/card-registry";
import { cardAnswerUrl } from "@/components/thread-transport";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { browserNotifyState, deliverNotification, setBrowserNotify, type BrowserNotifyState } from "@/components/needs-you-notify";
import { cn } from "@/lib/utils";
import { INITIAL_NOTIFY_STATE, cardHeadline, itemKey, mergeReport, planNotifications, withoutItem, type NeedsYouItem, type NotifyState } from "@/src/core";
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
	onToggle,
	onAnswer,
	onOpen,
}: {
	items: readonly NeedsYouItem[];
	expandedKey: string | null;
	submittingKey?: string | null;
	error?: string | null;
	now?: Date;
	onToggle(key: string): void;
	onAnswer(item: NeedsYouItem, answers: CardAnswers): void;
	onOpen(item: NeedsYouItem): void;
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

/** The browser opt-in for OS notifications (always visible in the sidebar footer; absent in Electron, which has its own). */
export function NotifyToggleView({ state, onToggle }: { state: BrowserNotifyState; onToggle(): void }) {
	if (state === "unsupported") return null;
	const on = state === "on";
	return (
		<div data-testid="needs-you-notify">
			<button
				type="button"
				data-testid="needs-you-notify-toggle"
				aria-pressed={on}
				disabled={state === "denied"}
				onClick={onToggle}
				className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors enabled:hover:bg-accent enabled:hover:text-foreground"
			>
				{on ? <BellIcon className="size-3" /> : <BellOffIcon className="size-3" />}
				{on ? "Notifications on" : "Notify me"}
			</button>
			{state === "denied" && (
				<p data-testid="needs-you-notify-denied" className="px-2 pb-1 text-xs normal-case text-muted-foreground">
					Notifications are blocked in your browser settings. Allow them for this site, then try again.
				</p>
			)}
		</div>
	);
}

export function NotifyToggle() {
	const [state, setState] = useState<BrowserNotifyState>("unsupported");
	useEffect(() => setState(browserNotifyState()), []);
	return (
		<NotifyToggleView
			state={state}
			onToggle={() =>
				void setBrowserNotify(state !== "on").then(() => setState(browserNotifyState()))
			}
		/>
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
	const notifyState = useRef<NotifyState>(INITIAL_NOTIFY_STATE);
	const inFlight = useRef(false);
	const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const itemsRef = useRef<NeedsYouItem[]>([]);
	// Wolves poked while a fetch ran (or all, ""): fetched in the next pass. Pokes name the wolf, so only that wolf is refetched.
	const queued = useRef<Set<string>>(new Set());
	const load = useCallback(
		async (wolf = "") => {
			queued.current.add(wolf);
			if (inFlight.current) return;
			inFlight.current = true;
			try {
				while (queued.current.size > 0) {
					const batch = [...queued.current];
					queued.current.clear();
					const targets = batch.includes("") ? [""] : batch;
					for (const target of targets) {
						try {
							const res = await fetch(target ? `/api/needs-you?wolf=${encodeURIComponent(target)}` : "/api/needs-you", { cache: "no-store" });
							if (!res.ok) continue;
							const body = (await res.json()) as { items?: NeedsYouItem[]; responded?: string[]; wolves?: string[] };
							if (!Array.isArray(body.items)) continue;
							const responded = body.responded ?? [];
							const next = mergeReport(itemsRef.current, responded, body.items, target === "" ? body.wolves : undefined);
							itemsRef.current = next;
							setItems(next);
							const plan = planNotifications(notifyState.current, next, { focused: document.hasFocus(), responded });
							notifyState.current = plan.state;
							for (const n of plan.notifications) deliverNotification(n, (href) => router.push(href));
						} catch {
							/* a transient failure keeps the last list; the next poke refetches */
						}
					}
				}
			} finally {
				inFlight.current = false;
			}
		},
		[router],
	);

	const pokedWolves = useRef<Set<string>>(new Set());
	const schedule = useCallback(
		(payload?: { wolf?: string }) => {
			const wolf = payload?.wolf ?? "";
			if (debounce.current) clearTimeout(debounce.current);
			pokedWolves.current.add(wolf);
			debounce.current = setTimeout(() => {
				const w = pokedWolves.current;
				pokedWolves.current = new Set();
				for (const x of w.has("") ? [""] : w) void load(x);
			}, 150);
		},
		[load],
	);
	useEffect(() => {
		void load();
		return () => {
			if (debounce.current) clearTimeout(debounce.current);
		};
	}, [load]);
	useServerEvent("needs-you-changed", schedule);
	useServerResync(() => void load());

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
					itemsRef.current = withoutItem(itemsRef.current, key);
					setItems(itemsRef.current);
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
			onToggle={(key) => {
				setError(null);
				setExpanded((cur) => (cur === key ? null : key));
			}}
			onAnswer={(item, answers) => void answer(item, answers)}
			onOpen={(item) => router.push(item.href)}
		/>
	);
}

