"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellIcon, BellOffIcon } from "lucide-react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { browserNotifyState, deliverNotification, setBrowserNotify, type BrowserNotifyState } from "@/components/needs-you-notify";
import { INITIAL_NOTIFY_STATE, itemKey, mergeReport, planNotifications, type NeedsYouItem, type NotifyState } from "@/src/core";

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
 * Headless needs-you driver (no UI): fetches /api/needs-you (refetching on every poke from the activity bridge and on
 * reconnect) and raises the OS notification when a card newly appears while the window is unfocused (planNotifications).
 * Mounted once, in the sidebar. The thread-row "needs you" mark is fed separately, by the thread list.
 */
export function NeedsYouNotifier(): null {
	const router = useRouter();
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
							const prior = notifyState.current;
							const plan = planNotifications(prior, next, { focused: document.hasFocus(), responded });
							notifyState.current = plan.state;
							if (plan.notifications.length === 0 && next.length > 0) {
								const focused = document.hasFocus();
								const fresh = next.filter((i) => !prior.seen.has(itemKey(i))).length;
								const why = fresh === 0 ? "all already seen" : focused ? "window focused" : "first report only primes";
								console.debug(`needs-you: no notification (${next.length} item(s): ${why})`);
							}
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

	return null;
}
