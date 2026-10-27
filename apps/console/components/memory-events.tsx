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
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
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
			es.onerror = () => cb(es.readyState === 2);
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
}

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

export function createMemoryHub(connect: (wolf: string) => MemorySource = openMemorySource) {
	const channels = new Map<string, Channel>();

	function open(wolf: string, ch: Channel) {
		const source = connect(wolf);
		ch.source = source;
		source.onOpen(() => {
			ch.attempt = 0;
			if (ch.opened) for (const cb of [...ch.resyncs]) safe(cb);
			ch.opened = true;
		});
		source.onMessage((raw) => {
			const frame = parseMemoryEventFrame(raw);
			if (!frame) return;
			for (const cb of [...ch.listeners]) safe(() => cb(frame));
		});
		source.onError((closed) => {
			if (!closed || ch.refs === 0 || ch.timer) return;
			source.close();
			ch.source = null;
			const delay = Math.min(RECONNECT_BASE_MS * 2 ** ch.attempt++, RECONNECT_MAX_MS);
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
				ch = { refs: 0, listeners: new Set(), resyncs: new Set(), source: null, opened: false, timer: null, attempt: 0 };
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
	const hub = useContext(MemoryEventsContext);
	if (!hub) throw new Error("useMemoryEvents requires <MemoryEventsProvider>");
	const cbRef = useRef(cb);
	cbRef.current = cb;
	const resyncRef = useRef(onResync);
	resyncRef.current = onResync;
	useEffect(() => {
		if (!wolf) return;
		return hub.subscribe(
			wolf,
			(e) => cbRef.current(e),
			() => resyncRef.current?.(),
		);
	}, [hub, wolf]);
}
