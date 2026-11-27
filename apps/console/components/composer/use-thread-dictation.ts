"use client";

import { useAttachedThread } from "@/components/chat-bar/attached-thread";
import { useDictation, type Dictation } from "@/components/composer/dictation";

/**
 * A thread page's dictation, now one path: the floating chat bar's (ChatBar, always mounted). On the attached thread's own page the bar is
 * docked into the page (the page has no composer of its own then), and on another thread's page the bar floats over it, so whenever a
 * thread is attached the bar's hook is the live one and this page hook stays disabled (idle; ⌘D reaches the bar's hook).
 *
 * The page's own run exists only for the fallback composer: nothing attached (a fresh browser, the hub down). Leaving the page mid-run
 * saves the words to the draft (`onOrphan`).
 */
export function useThreadDictation(
	append: (text: string) => void,
	onOrphan: (text: string) => void,
): Dictation {
	const api = useAttachedThread();
	return useDictation({ append, onOrphan, enabled: !api?.attached });
}
