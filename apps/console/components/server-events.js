"use client";
/**
 * THE NOTIFICATION CHANNEL'S CLIENT HALF (push-architecture slice 3,
 * 2026-10-02): ONE EventSource("/api/events") per open window, held for
 * the window's lifetime — the channel that retires the app's poll
 * lattice. Every server-initiated change arrives as a named SSE frame;
 * consumers respond by fetching truth (notify → fetch, the architecture's
 * whole trick — see src/core/events.ts and server/events-stream.ts).
 *
 * This file is the ONE place in the app that knows EventSource exists.
 * Auto-reconnect is EventSource's own — never fought, always exploited:
 * every (re)open fires the resync callbacks, so a reconnect heals with
 * one ordinary fetch per consumer (a dev-server restart self-heals here).
 *
 * Shape: the provider holds a hub (window-local fan-out — the client twin
 * of the server bus; per-window, NOT globalThis: each window's connection
 * is its own) and wires ONE source into it. The hooks are thin: latest-ref
 * callbacks (events fire between renders — never trust a stale closure)
 * plus hub membership for the component's lifetime.
 *
 * TEST SEAM: `connect` injects the source factory — the hub + wiring are
 * plain functions the tests drive directly (no React, no server); the
 * React glue is an adapter seam like lh:turn-state (untested by
 * precedent, components/session.ts).
 */
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { SERVER_EVENT_TYPES } from "@/src/core";
export function openEventsChannel() {
    const es = new EventSource("/api/events");
    return {
        close: () => es.close(),
        onOpen: (cb) => {
            es.onopen = () => cb();
        },
        onEvent: (name, cb) => {
            es.addEventListener(name, (ev) => cb(ev.data));
        },
    };
}
/** The per-window fan-out: typed subscriptions over one source. Listener
 *  errors are isolated per the bus's law (one bad consumer never breaks
 *  the window), and dispatch iterates a snapshot (an unsubscribe during
 *  dispatch is safe). */
export function createNotifyHub() {
    const byType = new Map();
    const resyncs = new Set();
    return {
        subscribe(type, cb) {
            const set = byType.get(type) ?? new Set();
            byType.set(type, set);
            const slot = cb;
            set.add(slot);
            return () => set.delete(slot);
        },
        /** Resync callbacks: fired on the source's every (re)open — "you may
         *  have missed events while disconnected; refetch". A consumer that
         *  mounts while ALREADY open gets no fire (it missed nothing by
         *  birth); its own mount fetch is its initial truth. */
        onResync(cb) {
            resyncs.add(cb);
            return () => resyncs.delete(cb);
        },
        /** One named frame arrived: parse, fan out. Unparseable frames are
         *  dropped loudly — the channel's payloads are tiny and schemaless,
         *  a bad frame must never half-fire. */
        dispatch(name, raw) {
            const set = byType.get(name);
            if (!set)
                return;
            let payload;
            try {
                payload = JSON.parse(raw);
            }
            catch (err) {
                console.error(`[events] unparseable frame for ${name}:`, err);
                return;
            }
            for (const cb of [...set]) {
                try {
                    cb(payload);
                }
                catch (err) {
                    console.error(`[events] ${name} handler failed:`, err);
                }
            }
        },
        fireOpen() {
            for (const cb of [...resyncs]) {
                try {
                    cb();
                }
                catch (err) {
                    console.error("[events] resync handler failed:", err);
                }
            }
        },
    };
}
/** Wire one source into a hub — the provider's ENTIRE effect body, factored
 *  out so the wiring is testable without React. Returns the disconnect. */
export function wireSource(source, hub) {
    for (const name of SERVER_EVENT_TYPES)
        source.onEvent(name, (raw) => hub.dispatch(name, raw));
    source.onOpen(() => hub.fireOpen());
    return () => source.close();
}
// ── the React glue ──────────────────────────────────────────────────────────
const EventsContext = createContext(null);
export function ServerEventsProvider({ children, connect }) {
    const hub = useMemo(() => createNotifyHub(), []);
    useEffect(() => wireSource((connect ?? openEventsChannel)(), hub), [hub, connect]);
    return <EventsContext.Provider value={hub}>{children}</EventsContext.Provider>;
}
/** Subscribe to one event type for this component's lifetime. The callback
 *  is a latest-ref: pass inline closures freely — the freshest render's
 *  closure runs, so state captured at the last completed render is safe to
 *  read (the provider re-stores it every render). */
export function useServerEvent(type, cb) {
    const hub = useContext(EventsContext);
    if (!hub)
        throw new Error("useServerEvent requires <ServerEventsProvider>");
    const cbRef = useRef(cb);
    cbRef.current = cb;
    useEffect(() => {
        const off = hub.subscribe(type, (payload) => cbRef.current(payload));
        return () => {
            off();
        };
    }, [hub, type]);
}
/** Refetch truth on every (re)connect of the window's channel — the
 *  self-heal seam for EventSource reconnects and dev-server restarts. */
export function useServerResync(cb) {
    const hub = useContext(EventsContext);
    if (!hub)
        throw new Error("useServerResync requires <ServerEventsProvider>");
    const cbRef = useRef(cb);
    cbRef.current = cb;
    useEffect(() => {
        const off = hub.onResync(() => cbRef.current());
        return () => {
            off();
        };
    }, [hub]);
}
//# sourceMappingURL=server-events.js.map