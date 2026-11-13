"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BellIcon, BellOffIcon } from "lucide-react";
import { desktopBridge } from "@/components/shell/sidebar";
import { useServerEvent, useServerResync } from "@/components/shell/server-events";
import { browserNotifyState, deliverNotification, setBrowserNotify, type BrowserNotifyState } from "@/components/shell/needs-you-notify";
import {
	INITIAL_NOTIFY_STATE,
	INITIAL_REPLY_STATE,
	dropReply,
	itemKey,
	notifyOnce,
	mergeReport,
	planNotifications,
	planReply,
	coalesced,
	syncBusy,
	threadSlug,
	trackThreadStatus,
	type NeedsYouItem,
	type NotifyState,
	type ReplyLocks,
	type ReplyNotifyState,
} from "@/src/core";

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
	useEffect(() => desktopBridge()?.onNavigate?.((href) => router.push(href)), [router]);

	return null;
}

/**
 * Headless reply driver: tracks which threads run a turn (status events, plus the thread lists on mount and on every
 * resync, so a turn running on load, or an idle lost across a reconnect, is handled) and, when a turn ends, fetches the
 * thread's recent page and lets planReply decide (the page's final message, new, owner-facing, not being looked at).
 * All decisions are in the pure core; this only fetches and delivers. Desktop: `always` makes main show it even with the
 * window focused (the thread check already happened here).
 */
export function ReplyNotifier(): null {
	const router = useRouter();
	const pathname = usePathname() ?? "";
	const pathRef = useRef(pathname);
	pathRef.current = pathname;
	const state = useRef<ReplyNotifyState>(INITIAL_REPLY_STATE);
	const ctl = useRef<AbortController | null>(null);
	if (ctl.current === null) ctl.current = new AbortController();
	const timers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
	useEffect(() => {
		// React strict mode re-runs effects: a fresh controller per mount; unmount stops fetches and pending retries.
		ctl.current = new AbortController();
		const pending = timers.current;
		return () => {
			ctl.current?.abort();
			for (const t of pending) clearTimeout(t);
			pending.clear();
		};
	}, []);

	type Fetched = { title: string; kind?: string; closed?: boolean; messages: { id: string; role: "user" | "assistant"; text: string }[] };
	const fetchThread = useCallback(async (wolf: string, threadId: string): Promise<Fetched | null> => {
		const signal = ctl.current?.signal;
		const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/threads/${encodeURIComponent(threadSlug(wolf, threadId))}?limit=20`, { cache: "no-store", ...(signal ? { signal } : {}) });
		return res.ok ? ((await res.json()) as Fetched) : null;
	}, []);

	// `turn` is the number planReply was handed when the turn ended: a retry of an older turn can neither judge nor drop a newer one.
	const judge = useCallback(
		async (wolf: string, threadId: string, turn: number, attempt = 0): Promise<void> => {
			try {
				const t = await fetchThread(wolf, threadId);
				if (!t || ctl.current?.signal.aborted) return;
				const plan = planReply(state.current, { wolf, id: threadId, ...t }, { focused: document.hasFocus(), visible: document.visibilityState === "visible", pathname: pathRef.current }, turn);
				state.current = plan.state;
				if (plan.notification) {
					const n = plan.notification;
					const deliver = () => deliverNotification(n, (href) => router.push(href), { always: true });
					// Electron is one window: no claim. Browser tabs: one tab per reply.
					void notifyOnce((desktopBridge() || typeof navigator === "undefined") ? undefined : (navigator.locks as ReplyLocks | undefined), n, deliver);
				}
				if (plan.retry) {
					if (attempt >= 3) {
						state.current = dropReply(state.current, wolf, threadId, turn);
						return;
					}
					const timer = setTimeout(() => {
						timers.current.delete(timer);
						void judge(wolf, threadId, turn, attempt + 1);
					}, 1500);
					timers.current.add(timer);
				}
			} catch {
				/* a missed reply notification is not worth surfacing */
			}
		},
		[fetchThread, router],
	);

	/**
	 * Prime from the thread lists (rows carry status, kind and closed: ThreadSummary): which owner-facing threads run a
	 * turn right now. Marks changed by events while the lists were fetched win (syncBusy). One run at a time: the mount
	 * and the first resync share it.
	 */
	const sync = useMemo(() => coalesced(async () => {
			try {
				const since = state.current.seq;
				const signal = ctl.current?.signal;
				const wolvesRes = await fetch("/api/wolves", { cache: "no-store", ...(signal ? { signal } : {}) });
				if (!wolvesRes.ok) return;
				const names = ((await wolvesRes.json()) as { wolves?: { name: string }[] }).wolves?.map((w) => w.name) ?? [];
				const covered: string[] = [];
				const threads: { wolf: string; threadId: string; status?: string }[] = [];
				await Promise.all(
					names.map(async (wolf) => {
						try {
							const res = await fetch(`/api/wolves/${encodeURIComponent(wolf)}/threads`, { cache: "no-store", ...(signal ? { signal } : {}) });
							if (!res.ok) return;
							const list = ((await res.json()) as { threads?: { id: string; status?: string; kind?: string; closed?: boolean }[] }).threads ?? [];
							covered.push(wolf);
							for (const t of list) if (t.kind !== "subagent" && t.kind !== "process" && !t.closed) threads.push({ wolf, threadId: t.id, ...(t.status ? { status: t.status } : {}) });
						} catch {
							/* an unreachable wolf is left alone */
						}
					}),
				);
				const before = state.current.pending;
				state.current = syncBusy(state.current, since, covered, threads);
				// lost-idle marks cleared by the sync: judge each such thread's reply once
				for (const [key, turn] of state.current.pending) {
					if (before.get(key) === turn) continue;
					const at = key.indexOf("\n");
					void judge(key.slice(0, at), key.slice(at + 1), turn);
				}
			} catch {
				/* the next resync retries */
			}
	}), [judge]);

	useEffect(() => {
		void sync();
	}, [sync]);
	useServerResync(() => void sync());

	useServerEvent("needs-you-changed", (ev) => {
		if (ev.kind !== "status" || !ev.threadId || !ev.status) return;
		const threadId = ev.threadId;
		const tracked = trackThreadStatus(state.current, { wolf: ev.wolf, threadId, status: ev.status });
		state.current = tracked.state;
		if (tracked.finished && tracked.turn !== undefined) void judge(ev.wolf, threadId, tracked.turn);
	});
	return null;
}

