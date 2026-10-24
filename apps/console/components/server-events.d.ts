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
import { type ReactNode } from "react";
import { type ServerEventType, type ServerEvents } from "@/src/core";
/** The minimal source surface the provider consumes — EventSource behind
 *  this in production, fakes in tests. */
export interface NotifySource {
    close(): void;
    onOpen(cb: () => void): void;
    onEvent(name: string, cb: (data: string) => void): void;
}
export declare function openEventsChannel(): NotifySource;
/** The per-window fan-out: typed subscriptions over one source. Listener
 *  errors are isolated per the bus's law (one bad consumer never breaks
 *  the window), and dispatch iterates a snapshot (an unsubscribe during
 *  dispatch is safe). */
export declare function createNotifyHub(): {
    subscribe<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void): () => boolean;
    /** Resync callbacks: fired on the source's every (re)open — "you may
     *  have missed events while disconnected; refetch". A consumer that
     *  mounts while ALREADY open gets no fire (it missed nothing by
     *  birth); its own mount fetch is its initial truth. */
    onResync(cb: () => void): () => boolean;
    /** One named frame arrived: parse, fan out. Unparseable frames are
     *  dropped loudly — the channel's payloads are tiny and schemaless,
     *  a bad frame must never half-fire. */
    dispatch(name: string, raw: string): void;
    fireOpen(): void;
};
/** Wire one source into a hub — the provider's ENTIRE effect body, factored
 *  out so the wiring is testable without React. Returns the disconnect. */
export declare function wireSource(source: NotifySource, hub: ReturnType<typeof createNotifyHub>): () => void;
export declare function ServerEventsProvider({ children, connect }: {
    children: ReactNode;
    connect?: () => NotifySource;
}): any;
/** Subscribe to one event type for this component's lifetime. The callback
 *  is a latest-ref: pass inline closures freely — the freshest render's
 *  closure runs, so state captured at the last completed render is safe to
 *  read (the provider re-stores it every render). */
export declare function useServerEvent<K extends ServerEventType>(type: K, cb: (payload: ServerEvents[K]) => void): void;
/** Refetch truth on every (re)connect of the window's channel — the
 *  self-heal seam for EventSource reconnects and dev-server restarts. */
export declare function useServerResync(cb: () => void): void;
//# sourceMappingURL=server-events.d.ts.map