"use client";

/**
 * The subagent-modal opener (context + hook), kept apart from the modal so the
 * floating bar can open a subagent without importing the chat session module
 * (the bar's runtime imports must not reach it). The modal's provider supplies it.
 */
import { createContext, useContext } from "react";

export interface SubagentOpener {
	/** Open the subagent modal over the current page: the child's thread id ("wolf/slug") and the wolf that owns it. */
	openSubagent: (childThreadId: string, wolf?: string) => void;
	closeSubagent: () => void;
}
export const OpenerContext = createContext<SubagentOpener | null>(null);
let warned = false;

/** `openSubagent(childThreadId, wolf)` from anywhere under <SubagentModalProvider>; outside one it does nothing. */
export function useSubagentModal(): SubagentOpener {
	const o = useContext(OpenerContext);
	if (!o && !warned && process.env.NODE_ENV !== "production") {
		warned = true;
		console.warn("useSubagentModal() used outside <SubagentModalProvider>: openSubagent is a no-op");
	}
	return o ?? { openSubagent: () => {}, closeSubagent: () => {} };
}
