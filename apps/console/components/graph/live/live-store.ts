"use client";

/**
 * THE SHARED LIVE FEED: one SSE stream per browser tab, reference counted. The graph overlay and any other consumer (the activity feed,
 * work-wolfpack-TVKc9Td) acquire it; the stream opens with the first one and closes with the last.
 *   useLiveActivity()   -> { state, recent }: the reduced pack state (same reducer as the overlay) and a ring of the last 50 events
 *                          (newest last), each { id, at (arrival ms), ts, verb, actor, target }.
 *   onLiveAction(fn)    -> raw actions (event / snapshot / resync), for consumers with their own reducer options (the overlay).
 */
import { useEffect, useSyncExternalStore } from "react";
import type { ActivityEvent } from "@wolfpack/protocol";
import { emptyLiveState, liveActive, liveSignature, reduceLive, seedFeedFromSnapshot, type LiveAction, type LiveState } from "@/src/core";
import { startLiveFeed } from "./live-client";

export interface RecentEvent { id: string; at: number; ts: number; verb: string; actor: ActivityEvent["actor"]; target?: ActivityEvent["target"] }
/** `connected`: the hub has answered (a presence snapshot or a stream frame arrived) since the feed opened. */
export interface LiveActivitySnapshot { state: LiveState; recent: readonly RecentEvent[]; connected: boolean }

export const RECENT_MAX = 50;
const EMPTY: LiveActivitySnapshot = { state: emptyLiveState(0), recent: [], connected: false };

let snapshot: LiveActivitySnapshot = EMPTY;
const subs = new Set<() => void>();
const listeners = new Set<(a: LiveAction) => void>();
let refs = 0;
let stopFeed: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let sig = "";

/** Subscribers hear about changes at most once per EMIT_MS (leading edge immediate, then one trailing call): a burst of activity
 *  events re-renders React once per window, not once per event. The snapshot itself is always current. */
export const EMIT_MS = 150;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let emitPending = false;
let lastEmitAt = -Infinity;
const flushEmit = () => {
	if (emitTimer) clearTimeout(emitTimer);
	emitTimer = null;
	if (!emitPending) return;
	emitPending = false;
	lastEmitAt = Date.now();
	subs.forEach((f) => f());
};
const emit = (now = false) => {
	emitPending = true;
	if (now || Date.now() - lastEmitAt >= EMIT_MS) return flushEmit();
	if (!emitTimer) emitTimer = setTimeout(flushEmit, Math.max(0, lastEmitAt + EMIT_MS - Date.now()));
};

/** The clock runs only while something can expire; with no live data there is no timer. */
function armTimer(): void {
	if (timer || refs === 0 || !liveActive(snapshot.state)) return;
	timer = setInterval(() => {
		if (typeof document === "undefined" || !document.hidden) dispatch({ type: "tick", now: Date.now() });
		if (!liveActive(snapshot.state) && timer) {
			clearInterval(timer);
			timer = null;
		}
	}, 1000);
}

function dispatch(a: LiveAction): void {
	// Ticks are the store's own clock: the overlay runs its own, so they are not forwarded.
	if (a.type !== "tick") for (const l of listeners) l(a);
	let state: LiveState;
	try {
		state = reduceLive(snapshot.state, a);
	} catch (err) {
		// One bad event is dropped, never fatal to the page.
		console.error("live feed: dropped an event the reducer could not apply", err);
		return;
	}
	let recent = snapshot.recent;
	if (a.type === "event") {
		const e = a.event;
		recent = [...recent, { id: e.id, at: a.now, ts: e.ts, verb: e.verb, actor: e.actor, target: e.target }].slice(-RECENT_MAX);
	}
	if (a.type === "snapshot") {
		// Seed the feed with who is busy right now (a quiet pack still shows what is going on); stream frames already in the ring win.
		const have = new Set(recent.map((r) => r.id));
		const seeded = seedFeedFromSnapshot(a.snapshot, a.now).filter((e) => !have.has(e.id));
		recent = [...seeded, ...recent].slice(-RECENT_MAX);
	}
	if (a.type === "tick") {
		const s = liveSignature(state);
		if (s === sig) return; // nothing visible changed: no re-render
		sig = s;
	}
	const wasConnected = snapshot.connected;
	snapshot = { state, recent, connected: wasConnected || a.type !== "tick" };
	emit(!wasConnected && snapshot.connected); // the hub answering is shown at once
	armTimer();
}

/** Open the shared stream (first holder) and get the release function. */
export function acquireLiveFeed(): () => void {
	refs++;
	if (refs === 1) {
		stopFeed = startLiveFeed({ dispatch });
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--refs > 0) return;
		stopFeed?.();
		stopFeed = null;
		if (timer) clearInterval(timer);
		timer = null;
		snapshot = EMPTY;
		sig = "";
		emit(true);
	};
}

/** The current shared snapshot (a late subscriber such as the overlay starts from it). */
export const getLiveSnapshot = (): LiveActivitySnapshot => snapshot;

/** Raw actions as they arrive (not replayed: a late subscriber sees the next snapshot/resync). */
export function onLiveAction(fn: (a: LiveAction) => void): () => void {
	listeners.add(fn);
	return () => void listeners.delete(fn);
}

/** Subscribe to (coalesced) snapshot changes. */
export const subscribeLive = (f: () => void): (() => void) => {
	subs.add(f);
	return () => void subs.delete(f);
};
const subscribe = subscribeLive;

/** Only whether the hub has answered: a consumer that needs nothing else re-renders on that flip alone. */
export function useLiveConnected(): boolean {
	return useSyncExternalStore(subscribe, () => snapshot.connected, () => false);
}

/** The shared live state and recent-event ring. Opens the stream while mounted (shared with the graph overlay). */
export function useLiveActivity(opts: { enabled?: boolean } = {}): LiveActivitySnapshot {
	const enabled = opts.enabled ?? true;
	useEffect(() => (enabled ? acquireLiveFeed() : undefined), [enabled]);
	return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

/** Feed one action through the shared pipeline as if it came from the stream (the dev-only KB life demo). */
export const injectLiveAction = (a: LiveAction): void => dispatch(a);
