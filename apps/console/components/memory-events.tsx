"use client";

/**
 * THE MEMORY EVENT CHANNEL (client half): one ref-counted EventSource per
 * wolf over /api/wolves/<wolf>/events, shared by every subscriber. The first
 * subscriber for a wolf opens it, the last one closes it. A stream the
 * browser gave up on (non-200, e.g. 409 memory_unavailable) is reopened with
 * backoff; EventSource's own auto-reconnect covers plain drops. Every
 * RE-open fires the wolf's resync callbacks ("you may have missed events:
 * refetch") — the first open does not.
 *
 * Frames go through parseMemoryEventFrame: unknown event types arrive as
 * generic `{type, ...}` frames; malformed frames are dropped.
 *
 * TEST SEAM: `createMemoryHub(connect)` is plain (no React); the provider is
 * the adapter glue.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { parseMemoryEventFrame, type MemoryEventFrame } from "@/src/core";

/** The minimal EventSource surface the hub consumes. */
export interface MemorySource {
	close(): void;
	/** Fires on every (re)open. */
	onOpen(cb: () => void): void;
	onMessage(cb: (data: string) => void): void;
	/** `closed` = the browser gave up (no auto-reconnect coming). */
	onError(cb: (closed: boolean) => void): void;
}

export function openMemorySource(wolf: string): MemorySource {
	const es = new EventSource(`/api/wolves/${encodeURIComponent(wolf)}/events`);
	return {
		close: () => es.close(),
		onOpen: (cb) => {
			es.onopen = () => cb();
		},
		onMessage: (cb) => {
			es.onmessage = (ev) => cb(ev.data as string);
		},
		onError: (cb) => {
			es.addEventListener("error", (ev) => {
				// A server `event: error` frame is a MessageEvent: terminal, and EventSource would
				// otherwise reconnect immediately. Transport errors are plain Events.
				if (ev instanceof MessageEvent) {
					es.close();
					cb(true);
				} else cb(es.readyState === 2);
			});
		},
	};
}

type Listener = (e: MemoryEventFrame) => void;

interface Channel {
	refs: number;
	listeners: Set<Listener>;
	resyncs: Set<() => void>;
	source: MemorySource | null;
	opened: boolean;
	timer: ReturnType<typeof setTimeout> | null;
	attempt: number;
	openedAt: number;
	flaps: number;
}

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

/** An open that errors within this window counts as a flap; FLAP_LIMIT flaps in a row are treated as closed. */
export const FLAP_MS = 2000;
export const FLAP_LIMIT = 2;

export interface MemoryHubOptions {
	baseMs?: number;
	maxMs?: number;
	now?: () => number;
}

export function createMemoryHub(connect: (wolf: string) => MemorySource = openMemorySource, opts: MemoryHubOptions = {}) {
	const baseMs = opts.baseMs ?? RECONNECT_BASE_MS;
	const maxMs = opts.maxMs ?? RECONNECT_MAX_MS;
	const now = opts.now ?? Date.now;
	const channels = new Map<string, Channel>();

	function open(wolf: string, ch: Channel) {
		const source = connect(wolf);
		ch.source = source;
		source.onOpen(() => {
			ch.openedAt = now();
			if (ch.opened) for (const cb of [...ch.resyncs]) safe(cb);
			ch.opened = true;
		});
		source.onMessage((raw) => {
			const frame = parseMemoryEventFrame(raw);
			if (!frame) return;
			for (const cb of [...ch.listeners]) safe(() => cb(frame));
		});
		source.onError((closed) => {
			if (ch.refs === 0 || ch.timer) return;
			if (!closed) {
				// Rapid open→error cycles (server answers 200 then drops) never reach "closed" by
				// themselves: count them and back off like a refusal.
				if (ch.openedAt && now() - ch.openedAt < FLAP_MS) ch.flaps++;
				else {
					ch.flaps = 0;
					ch.attempt = 0;
				}
				if (ch.flaps < FLAP_LIMIT) return;
			} else if (ch.openedAt && now() - ch.openedAt >= FLAP_MS) {
				ch.attempt = 0;
			}
			ch.openedAt = 0;
			source.close();
			ch.source = null;
			const delay = Math.min(baseMs * 2 ** ch.attempt++, maxMs);
			ch.timer = setTimeout(() => {
				ch.timer = null;
				if (ch.refs > 0) open(wolf, ch);
			}, delay);
		});
	}

	return {
		subscribe(wolf: string, cb: Listener, onResync?: () => void): () => void {
			let ch = channels.get(wolf);
			if (!ch) {
				ch = { refs: 0, listeners: new Set(), resyncs: new Set(), source: null, opened: false, timer: null, attempt: 0, openedAt: 0, flaps: 0 };
				channels.set(wolf, ch);
			}
			const channel = ch;
			channel.refs++;
			channel.listeners.add(cb);
			if (onResync) channel.resyncs.add(onResync);
			if (!channel.source && !channel.timer) open(wolf, channel);
			return () => {
				channel.listeners.delete(cb);
				if (onResync) channel.resyncs.delete(onResync);
				if (--channel.refs > 0) return;
				if (channel.timer) clearTimeout(channel.timer);
				channel.source?.close();
				channels.delete(wolf);
			};
		},
		/** Open channel count (tests). */
		size: () => channels.size,
	};
}

function safe(fn: () => void) {
	try {
		fn();
	} catch (err) {
		console.error("[memory-events] handler failed:", err);
	}
}

export type MemoryHub = ReturnType<typeof createMemoryHub>;

const MemoryEventsContext = createContext<MemoryHub | null>(null);

export function MemoryEventsProvider({ children, connect }: { children: ReactNode; connect?: (wolf: string) => MemorySource }) {
	const hub = useMemo(() => createMemoryHub(connect), [connect]);
	return <MemoryEventsContext.Provider value={hub}>{children}</MemoryEventsContext.Provider>;
}

/**
 * Subscribe to a wolf's memory events for this component's lifetime (null =
 * no subscription). `cb` and `onResync` are latest-ref: inline closures are
 * fine. `onResync` fires after a reconnect (refetch truth there).
 */
export function useMemoryEvents(wolf: string | null, cb: (e: MemoryEventFrame) => void, onResync?: () => void): void {
	useMemoryEventsImpl(wolf, cb, onResync, true);
}

/** Like {@link useMemoryEvents}, but a no-op without a provider (components that also render standalone, e.g. in tests). */
export function useOptionalMemoryEvents(wolf: string | null, cb: (e: MemoryEventFrame) => void, onResync?: () => void): void {
	useMemoryEventsImpl(wolf, cb, onResync, false);
}

function useMemoryEventsImpl(wolf: string | null, cb: (e: MemoryEventFrame) => void, onResync: (() => void) | undefined, required: boolean): void {
	const hub = useContext(MemoryEventsContext);
	if (!hub && required) throw new Error("useMemoryEvents requires <MemoryEventsProvider>");
	const cbRef = useRef(cb);
	const resyncRef = useRef(onResync);
	useLayoutEffect(() => {
		cbRef.current = cb;
		resyncRef.current = onResync;
	});
	useEffect(() => {
		if (!wolf || !hub) return;
		return hub.subscribe(
			wolf,
			(e) => cbRef.current(e),
			() => resyncRef.current?.(),
		);
	}, [hub, wolf]);
}
