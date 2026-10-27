"use client";

/**
 * The pack's librarian wolf, resolved once from /api/wolves (WolfSummary
 * .librarian). `loading` is true until the first answer; afterwards
 * `librarian` is the wolf's name or null (none flagged / fetch failed).
 */
import { useEffect, useState } from "react";
import { findLibrarian } from "@/src/core";
import { fetchWolves } from "./kb-client";

export interface LibrarianState {
	librarian: string | null;
	loading: boolean;
}

export function useLibrarian(): LibrarianState {
	const [state, setState] = useState<LibrarianState>({ librarian: null, loading: true });
	useEffect(() => {
		let cancelled = false;
		void fetchWolves().then((res) => {
			if (cancelled) return;
			setState({ librarian: res.ok ? (findLibrarian(res.data.wolves)?.name ?? null) : null, loading: false });
		});
		return () => {
			cancelled = true;
		};
	}, []);
	return state;
}
