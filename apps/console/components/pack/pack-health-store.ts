"use client";

/**
 * The one pack-health subscription per page (work-wolfpack-6imFEq7). Every bar and the Pack page read this store through
 * useSyncExternalStore; the first subscriber opens the connection (src/core/pack/pack-health-connection.ts) and the last one to
 * leave closes it, so the desktop and phone sidebars share one stream. The Pack page takes a hold on it (holdPackHealth) while mounted.
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
	/** The Pack page is open: the clock ticks. */
	held: boolean;
}

const INITIAL: PackHealthState = { snapshot: null, reachable: true, lastSeenAt: null, updatedAt: 0, fakeRestart: null, fakeLogs: null, fakeRollback: null, held: false };
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

/** The Pack page holds the stream while it is mounted (a counted subscriber, so it outlives the bars); returns the release. */
let holds = 0;
export function holdPackHealth(): () => void {
	const release = subscribePackHealth(() => {});
	holds++;
	set({ held: true });
	let done = false;
	return () => {
		if (done) return;
		done = true;
		holds--;
		set({ held: holds > 0 });
		release();
	};
}
