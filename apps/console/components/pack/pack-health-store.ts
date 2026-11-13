"use client";

/**
 * The one pack-health subscription per page (work-wolfpack-6imFEq7). Every bar and the modal host read this store through
 * useSyncExternalStore; the first subscriber opens the connection (src/core/pack/pack-health-connection.ts) and the last one to
 * leave closes it, so the desktop and phone sidebars share one stream. The modal's open state lives here too, so the modal
 * survives the phone list layer closing under it.
 *   dev: ?healthFixture=<name> / ?healthRestart= / ?healthLogs= / ?healthRollback=<status> load components/pack/pack-health-fixtures.ts with a dynamic import, only
 *        outside production, so the fixtures stay out of the production bundle.
 */
import { createHealthConnection, type HealthConnectionDeps, type PackSectionId, type HealthSnapshotView } from "@/src/core";

export interface PackHealthState {
	snapshot: HealthSnapshotView | null;
	reachable: boolean;
	/** When the last good snapshot arrived. */
	lastSeenAt: number | null;
	/** When anything last changed (a snapshot, or a failed poll): the bar's clock between ticks. */
	updatedAt: number;
	/** Dev only: answer restarts with this status instead of calling the server. */
	fakeRestart: number | null;
	/** Dev only: answer logs / rollbacks with this status instead of calling the server. */
	fakeLogs: number | null;
	fakeRollback: number | null;
	modalOpen: boolean;
}

const INITIAL: PackHealthState = { snapshot: null, reachable: true, lastSeenAt: null, updatedAt: 0, fakeRestart: null, fakeLogs: null, fakeRollback: null, modalOpen: false };
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
	if (process.env.NODE_ENV === "production" || !/[?&]health(Fixture|Restart|Logs|Rollback)=/.test(search)) return startLive();
	let stopped = false;
	let stop = () => {};
	void import("@/components/pack/pack-health-fixtures").then(({ fixtureFromUrl, fixtureSnapshot }) => {
		if (stopped) return;
		const { fixture, restartStatus, logsStatus, rollbackStatus } = fixtureFromUrl(search);
		set({ fakeRestart: restartStatus, fakeLogs: logsStatus, fakeRollback: rollbackStatus });
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

let pendingSection: PackSectionId | null = null;
/** The section the current open asked for; the panel reads it when it mounts (a pure read: strict mode may mount twice). Cleared on close. */
export function requestedPackSection(): PackSectionId {
	return pendingSection ?? "machines";
}

/** Open the modal; `from` is the bar button that gets focus back on close. */
export function openPackHealth(from: HTMLElement | null, section?: PackSectionId): void {
	opener = from;
	pendingSection = section ?? null;
	if (modalHold === null) modalHold = subscribePackHealth(() => {});
	set({ modalOpen: true });
}
/** Close the modal and drop its hold on the stream (also called when the host unmounts with the modal open). */
export function closePackHealth(o?: { restoreFocus?: boolean }): void {
	pendingSection = null;
	skipFocus = o?.restoreFocus === false; // another dialog is taking over (Old settings): focus must not jump to the opener
	set({ modalOpen: false });
	const release = modalHold;
	modalHold = null;
	release?.();
}

/** After the modal closed: focus the bar that opened it, or else any bar still on screen (the phone list may have hidden it). */
let skipFocus = false;
export function focusPackHealthOpener(): void {
	if (skipFocus) {
		skipFocus = false;
		opener = null;
		return;
	}
	const shown = (el: HTMLElement | null): el is HTMLElement => !!el?.isConnected && el.getClientRects().length > 0;
	const target = shown(opener) ? opener : Array.from(document.querySelectorAll<HTMLElement>('[data-testid="settings-entry"]')).find(shown);
	opener = null;
	target?.focus();
}
