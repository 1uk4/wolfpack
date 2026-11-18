/**
 * Pack health connection (work-wolfpack-6imFEq7): keeps the console's /api/health snapshot coming, with no React in it.
 * The EventSource, fetch and timers are injected so the reconnect rules can be tested.
 *   stream:   EventSource /api/health/stream; each frame is the whole snapshot and resets the reopen backoff.
 *   fallback: on a stream error, or no frame for max(30 s, 3 intervals), close the stream and poll /api/health every
 *             interval (one chain, guarded by `polling`). A failed poll marks the console unreachable.
 *   reopen:   after a good poll, reopen the stream once a backoff has passed (5 s, 10 s, 20 s… capped at 60 s), polling
 *             meanwhile. Without EventSource it only polls.
 *   stop:     closes the stream, aborts the in-flight poll and clears every timer.
 */
import type { HealthSnapshotView } from "./pack-health-view";

export interface EventSourceLike {
	onmessage: ((e: { data: string }) => void) | null;
	onerror: (() => void) | null;
	close(): void;
}
export interface HealthConnectionDeps {
	EventSource: (new (url: string) => EventSourceLike) | undefined;
	fetch: (url: string, init: { cache: "no-store"; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (t: unknown) => void;
	onSnapshot: (snap: HealthSnapshotView) => void;
	onUnreachable: () => void;
}

const STALL_MS = 30_000;
const FETCH_TIMEOUT_MS = 8_000;
const REOPEN_FIRST_MS = 5_000;
const REOPEN_MAX_MS = 60_000;

export function createHealthConnection(d: HealthConnectionDeps): { start(): void; stop(): void } {
	let closed = false;
	let es: EventSourceLike | null = null;
	let stall: unknown;
	let nextPoll: unknown;
	let reopen: unknown;
	let polling = false;
	let inflight: AbortController | null = null;
	let fetchTimer: unknown;
	let interval = 5_000;
	let backoff = REOPEN_FIRST_MS;

	const got = (snap: HealthSnapshotView) => {
		interval = snap.intervalMs >= 1000 ? snap.intervalMs : 5_000;
		d.onSnapshot(snap);
	};
	const armStall = () => {
		d.clearTimeout(stall);
		stall = d.setTimeout(fallBack, Math.max(STALL_MS, interval * 3));
	};
	const stopPolling = () => {
		polling = false;
		d.clearTimeout(nextPoll);
		nextPoll = undefined;
		d.clearTimeout(fetchTimer);
		inflight?.abort();
		inflight = null;
	};
	const open = () => {
		reopen = undefined;
		if (closed || d.EventSource === undefined) return;
		stopPolling();
		es?.close();
		const s = new d.EventSource("/api/health/stream");
		es = s;
		s.onmessage = (e) => {
			if (es !== s) return;
			try {
				got(JSON.parse(e.data) as HealthSnapshotView);
			} catch {
				return; // a bad frame: keep the last snapshot
			}
			backoff = REOPEN_FIRST_MS;
			armStall();
		};
		s.onerror = () => {
			if (es === s) fallBack();
		};
		armStall();
	};
	function fallBack() {
		d.clearTimeout(stall);
		es?.close();
		es = null;
		if (closed || polling) return;
		polling = true;
		void pollOnce();
	}
	const pollOnce = async () => {
		nextPoll = undefined;
		if (closed || !polling) return;
		const ac = new AbortController();
		inflight = ac;
		fetchTimer = d.setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
		let ok = false;
		try {
			const r = await d.fetch("/api/health", { cache: "no-store", signal: ac.signal });
			if (!r.ok) throw new Error(`health ${r.status}`);
			const snap = (await r.json()) as HealthSnapshotView;
			if (inflight !== ac) return; // stopped or superseded while waiting
			got(snap);
			ok = true;
		} catch {
			if (inflight !== ac) return; // aborted by stop() or by the stream taking over
			d.onUnreachable();
		} finally {
			if (inflight === ac) d.clearTimeout(fetchTimer);
		}
		inflight = null;
		if (ok && d.EventSource !== undefined && reopen === undefined) {
			reopen = d.setTimeout(open, backoff);
			backoff = Math.min(backoff * 2, REOPEN_MAX_MS);
		}
		if (!closed && polling) nextPoll = d.setTimeout(() => void pollOnce(), interval);
	};

	return {
		start() {
			if (closed) return;
			if (d.EventSource === undefined) fallBack();
			else open();
		},
		stop() {
			closed = true;
			stopPolling();
			d.clearTimeout(stall);
			d.clearTimeout(reopen);
			es?.close();
			es = null;
		},
	};
}
