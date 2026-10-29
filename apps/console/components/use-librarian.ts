"use client";

/**
 * The pack's librarian wolf (and the KB source, which falls back to a read-only mirror), resolved once from /api/wolves (WolfSummary
 * .librarian). `loading` is true until the first answer; afterwards
 * `librarian` is the wolf's name or null (none flagged / fetch failed).
 */
import { useEffect, useState } from "react";
import { findKbSource, findLibrarian, type KbSource } from "@/src/core";
import { fetchWolves } from "./kb-client";

export interface LibrarianState {
	librarian: string | null;
	/** Where the graph and entries are read from: the librarian, else a wolf with a KB mirror. Null = none can. */
	kbSource: KbSource | null;
	loading: boolean;
}

export function useLibrarian(): LibrarianState {
	const [state, setState] = useState<LibrarianState>({ librarian: null, kbSource: null, loading: true });
	useEffect(() => {
		let cancelled = false;
		void fetchWolves().then((res) => {
			if (cancelled) return;
			const wolves = res.ok ? res.data.wolves : [];
			setState({ librarian: findLibrarian(wolves)?.name ?? null, kbSource: findKbSource(wolves), loading: false });
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return state;
}
