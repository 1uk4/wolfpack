"use client";

/**
 * The one pack-health subscription per page (work-wolfpack-6imFEq7). Every bar and the modal host read this store through
 * useSyncExternalStore; the first subscriber opens the connection (src/core/pack-health-connection.ts) and the last one to
 * leave closes it, so the desktop and phone sidebars share one stream. The modal's open state lives here too, so the modal
 * survives the phone list layer closing under it.
 *   dev: ?healthFixture=<name> / ?healthRestart=<status> load components/pack-health-fixtures.ts with a dynamic import, only
 *        outside production, so the fixtures stay out of the production bundle.
 */
import { createHealthConnection, type HealthConnectionDeps } from "@/src/core/pack-health-connection";
import type { HealthSnapshotView } from "@/src/core/pack-health-view";

export interface PackHealthState {
	snapshot: HealthSnapshotView | null;
	reachable: boolean;
	/** When the last good snapshot arrived. */
	lastSeenAt: number | null;
	/** When anything last changed (a snapshot, or a failed poll): the bar's clock between ticks. */
	updatedAt: number;
	/** Dev only: answer restarts with this status instead of calling the server. */
	fakeRestart: number | null;
	modalOpen: boolean;
}

const INITIAL: PackHealthState = { snapshot: null, reachable: true, lastSeenAt: null, updatedAt: 0, fakeRestart: null, modalOpen: false };
let state = INITIAL;
const listeners = new Set<() => void>();
let stopSource: (() => void) | null = null;
let opener: HTMLElement | null = null;

function set(patch: Partial<PackHealthState>): void {
	state = { ...state, ...patch };
	for (const l of listeners) l();
}

function startLive(): () => void {
	const conn = createHealthConnection({
		EventSource: typeof EventSource === "undefined" ? undefined : (EventSource as unknown as HealthConnectionDeps["EventSource"]),
		fetch: (url, init) => fetch(url, init), // looked up per call: the hub-auth wrapper replaces window.fetch
		setTimeout: (fn, ms) => window.setTimeout(fn, ms),
		clearTimeout: (t) => window.clearTimeout(t as number | undefined),
		onSnapshot: (snapshot) => {
			const t = Date.now();
			set({ snapshot, reachable: true, lastSeenAt: t, updatedAt: t });
		},
		onUnreachable: () => set({ reachable: false, updatedAt: Date.now() }),
	});
	conn.start();
	return () => conn.stop();
}

function startSource(): () => void {
	if (typeof window === "undefined") return () => {};
	const search = window.location?.search ?? ""; // location is absent in the DOM test shims
	if (process.env.NODE_ENV === "production" || !/[?&]health(Fixture|Restart)=/.test(search)) return startLive();
	let stopped = false;
	let stop = () => {};
	void import("@/components/pack-health-fixtures").then(({ fixtureFromUrl, fixtureSnapshot }) => {
		if (stopped) return;
		const { fixture, restartStatus } = fixtureFromUrl(search);
		set({ fakeRestart: restartStatus });
		if (!fixture) return void (stop = startLive());
		const apply = () => {
			const t = Date.now();
			if (fixture === "unreachable") set({ snapshot: fixtureSnapshot("ok", t - 3 * 60_000), reachable: false, lastSeenAt: t - 3 * 60_000, updatedAt: t });
			else set({ snapshot: fixtureSnapshot(fixture, t), reachable: true, lastSeenAt: t, updatedAt: t });
		};
		apply();
		const timer = window.setInterval(apply, 2_000);
		stop = () => window.clearInterval(timer);
	});
	return () => {
		stopped = true;
		stop();
	};
}

let subscribers = 0;

/** A counted subscriber: the first one opens the connection, the last one to leave closes it. */
export function subscribePackHealth(listener: () => void): () => void {
	listeners.add(listener);
	subscribers++;
	if (stopSource === null) stopSource = startSource();
	return () => {
		listeners.delete(listener);
		subscribers--;
		if (subscribers === 0 && stopSource !== null) {
			stopSource();
			stopSource = null;
		}
	};
}

/** Listen without counting as a subscriber: never opens the connection on its own (the host's live region). */
export function watchPackHealth(listener: () => void): () => void {
	listeners.add(listener);
	return () => void listeners.delete(listener);
}

export const getPackHealth = (): PackHealthState => state;
export const getServerPackHealth = (): PackHealthState => INITIAL;

/** While the modal is open it is a counted subscriber, so it keeps the stream alive after every bar unmounts. */
let modalHold: (() => void) | null = null;

/** Open the modal; `from` is the bar button that gets focus back on close. */
export function openPackHealth(from: HTMLElement | null): void {
	opener = from;
	if (modalHold === null) modalHold = subscribePackHealth(() => {});
	set({ modalOpen: true });
}
/** Close the modal and drop its hold on the stream (also called when the host unmounts with the modal open). */
export function closePackHealth(): void {
	set({ modalOpen: false });
	const release = modalHold;
	modalHold = null;
	release?.();
}

/** After the modal closed: focus the bar that opened it, or else any bar still on screen (the phone list may have hidden it). */
export function focusPackHealthOpener(): void {
	const shown = (el: HTMLElement | null): el is HTMLElement => !!el?.isConnected && el.getClientRects().length > 0;
	const target = shown(opener) ? opener : Array.from(document.querySelectorAll<HTMLElement>('[data-testid="pack-health-bar"]')).find(shown);
	opener = null;
	target?.focus();
}
