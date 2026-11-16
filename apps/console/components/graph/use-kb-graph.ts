"use client";

/**
 * The KB graph from the librarian, as view state.
 *
 *   status: "loading"     first fetch in flight, nothing to show yet
 *           "ready"       `graph` is the librarian's payload
 *           "unavailable" no wolf can read the KB (or it answered 409) — a
 *                         clear empty state, not an error
 *           "error"       any other failure (`message` says what)
 *
 * Layer toggles and the domain filter are the query: changing them refetches.
 * `refetch()` re-runs the current query — the Live-activity task calls it on
 * `sweep_finished`. While a refetch is in flight the previous graph stays in
 * `graph` (status stays "ready"), so the canvas never blanks; the view feeds
 * the new payload to the renderer with the positions it already has.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { KbGraph } from "@/src/core";
import { dataStore } from "@/src/core/data-store";
import { fetchKbGraph, kbGraphUrl, type KbGraphOptions } from "../kb/kb-client";

/** A graph this young is shown as is when the page mounts; the 30 s poll and `refetch()` still revalidate. */
export const GRAPH_MOUNT_MAX_AGE_MS = 30_000;

export type KbGraphStatus = "loading" | "ready" | "unavailable" | "error";

export interface KbGraphState {
	status: KbGraphStatus;
	graph: KbGraph | null;
	message: string | null;
	/** True while `graph` was fetched with an OLDER query than the current
	 *  one (a toggle/filter change is in flight; the old graph stays up). */
	isStale: boolean;
	/** Re-run the current query (keeps the current graph on screen meanwhile). */
	refetch: () => void;
}

/** The server picks the source (hub copy in relay mode, else a KB wolf); "unavailable" comes back from it (409).
 *  Pass `loading: true` while the view's own settings are still loading. */
export function useKbGraph(loading: boolean, query: KbGraphOptions): KbGraphState {
	// A graph already in the store renders on the first render (no loading flash); the effect below still revalidates it when it is older than the mount age.
	const [state, setState] = useState<Omit<KbGraphState, "refetch" | "isStale">>(() => {
		const warm = dataStore.read<KbGraph>(kbGraphUrl(query));
		return warm ? { status: "ready", graph: warm.data, message: null } : { status: "loading", graph: null, message: null };
	});
	// The query key the current `graph` was fetched with.
	const [settledKey, setSettledKey] = useState<string | null>(() => (dataStore.read(kbGraphUrl(query)) ? JSON.stringify([query.domain ?? null, !!query.archivedWork, !!query.denTopics]) : null));
	const [tick, setTick] = useState(0);
	// A mount or a query change may reuse a graph younger than GRAPH_MOUNT_MAX_AGE_MS; an explicit refetch never does.
	const forceRef = useRef(false);
	const refetch = useCallback(() => {
		forceRef.current = true;
		setTick((t) => t + 1);
	}, []);
	// A stable key for the query object (callers pass a fresh literal).
	const queryKey = JSON.stringify([query.domain ?? null, !!query.archivedWork, !!query.denTopics]);
	const queryRef = useRef(query);
	queryRef.current = query;

	useEffect(() => {
		if (loading) return;
		let cancelled = false;
		const maxAge = forceRef.current ? 0 : GRAPH_MOUNT_MAX_AGE_MS;
		forceRef.current = false;
		void fetchKbGraph(queryRef.current, maxAge).then((res) => {
			if (cancelled) return;
			// Failures settle the key too: nothing newer is coming, so
			// waiters must not wait forever.
			setSettledKey(queryKey);
			if (res.ok) setState({ status: "ready", graph: res.data, message: null });
			else if (res.reason === "unavailable") setState({ status: "unavailable", graph: null, message: res.message });
			else setState((prev) => ({ status: "error", graph: prev.graph, message: res.message }));
		});
		return () => {
			cancelled = true;
		};
	}, [loading, queryKey, tick]);

	return { ...state, isStale: settledKey !== queryKey, refetch };
}
