"use client";

/**
 * The graph's visual groups (work-wolfpack-FnzgC6g), saved in the console's own data dir via /api/graph/groups so every device on
 * this console sees the same bubbles. Loaded once after mount; each edit applies at once and is saved right away (edits are rare
 * and deliberate, so no debounce).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EMPTY_GROUPS, dataStore, sanitizeGroups, type GraphGroups } from "@/src/core";

export interface GraphGroupsState {
	groups: GraphGroups;
	loaded: boolean;
	/** Apply a change (use the pure helpers from src/core/graph/groups.ts) and save it. */
	changeGroups: (update: (cur: GraphGroups) => GraphGroups) => void;
}

export function useGraphGroups(): GraphGroupsState {
	const [groups, setGroups] = useState<GraphGroups>(EMPTY_GROUPS);
	const [loaded, setLoaded] = useState(false);
	const ref = useRef(groups);
	ref.current = groups;
	const touched = useRef(false);

	useEffect(() => {
		dataStore
			.load<unknown>("/api/graph/groups", { maxAgeMs: 30_000 })
			.then((raw) => {
				if (!touched.current) setGroups(sanitizeGroups(raw));
			})
			.catch(() => {})
			.finally(() => setLoaded(true));
	}, []);

	const changeGroups = useCallback((update: (cur: GraphGroups) => GraphGroups) => {
		touched.current = true;
		const next = sanitizeGroups(update(ref.current));
		ref.current = next;
		setGroups(next);
		fetch("/api/graph/groups", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) })
			.then(() => dataStore.invalidate("/api/graph/groups"))
			.catch((err) => console.error("[graph] groups save failed:", err));
	}, []);

	return { groups, loaded, changeGroups };
}
