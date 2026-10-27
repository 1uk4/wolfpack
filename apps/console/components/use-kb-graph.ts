"use client";

/**
 * The KB graph from the librarian, as view state.
 *
 *   status: "loading"     first fetch in flight, nothing to show yet
 *           "ready"       `graph` is the librarian's payload
 *           "unavailable" no librarian online (or it answered 409) — a
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
import { fetchKbGraph, type KbGraphOptions } from "./kb-client";

export type KbGraphStatus = "loading" | "ready" | "unavailable" | "error";

export interface KbGraphState {
	status: KbGraphStatus;
	graph: KbGraph | null;
	message: string | null;
	/** Re-run the current query (keeps the current graph on screen meanwhile). */
	refetch: () => void;
}

/** `librarian` null = no librarian known (after wolves loaded) → unavailable;
 *  pass `loading: true` while that is still being resolved. */
export function useKbGraph(librarian: string | null, loading: boolean, query: KbGraphOptions): KbGraphState {
	const [state, setState] = useState<Omit<KbGraphState, "refetch">>({ status: "loading", graph: null, message: null });
	const [tick, setTick] = useState(0);
	const refetch = useCallback(() => setTick((t) => t + 1), []);
	// A stable key for the query object (callers pass a fresh literal).
	const queryKey = JSON.stringify([query.domain ?? null, !!query.archivedWork, !!query.wikilinks, !!query.denTopics]);
	const queryRef = useRef(query);
	queryRef.current = query;

	useEffect(() => {
		if (loading) return;
		if (!librarian) {
			setState({ status: "unavailable", graph: null, message: "No librarian is online." });
			return;
		}
		let cancelled = false;
		void fetchKbGraph(librarian, queryRef.current).then((res) => {
			if (cancelled) return;
			if (res.ok) setState({ status: "ready", graph: res.data, message: null });
			else if (res.reason === "unavailable") setState({ status: "unavailable", graph: null, message: res.message });
			else setState((prev) => ({ status: "error", graph: prev.graph, message: res.message }));
		});
		return () => {
			cancelled = true;
		};
	}, [librarian, loading, queryKey, tick]);

	return { ...state, refetch };
}
