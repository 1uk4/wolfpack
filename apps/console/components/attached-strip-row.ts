"use client";

import { useMemo } from "react";
import { useAttachedThread } from "@/components/attached-thread";
import { attachedThreadTitle } from "@/components/chat-bar";
import { useBarDictation, type Dictation } from "@/components/dictation";
import { useThreadColor } from "@/components/use-thread-color";

export interface AttachedRow {
	title: string;
	/** The thread's color (hex). */
	color: string;
	state: "idle" | "busy" | "needs-you";
	listening: boolean;
	/** Ends the live run (set while listening). */
	onStop?: () => void;
	/** The chat bar's live run (set while listening), the source of the strip's level meter. */
	dictation?: Dictation;
	onOpen: () => void;
}

/**
 * On a thread page that is NOT the attached thread, the floating chat shows as a row in the subagent strip
 * above the composer (the bar is off on those pages, phone and wide). Null with nothing attached, or on the attached
 * thread's own page (its composer is the chat).
 */
export function useAttachedStripRow(wolf: string, threadId: string): AttachedRow | null {
	const api = useAttachedThread();
	const bar = useBarDictation();
	const attached = api?.attached ?? null;
	const all = useMemo(() => Object.values(api?.threads ?? {}).flatMap((l) => l ?? []), [api?.threads]);
	const t = api?.attachedThread;
	const color = useThreadColor({ id: attached?.threadId ?? "", ...(t?.settings ? { settings: t.settings } : {}), ...(t?.parentThreadId ? { parentThreadId: t.parentThreadId } : {}) }, all).hex;
	if (!api || !attached) return null;
	if (attached.wolf === wolf && attached.threadId === threadId) return null;
	const status = t?.status;
	return {
		title: attachedThreadTitle(api, attached),
		color,
		state: status === "needs-you" ? "needs-you" : api.working ? "busy" : "idle",
		listening: !!bar?.active,
		...(bar?.active ? { onStop: bar.toggle, dictation: bar } : {}),
		onOpen: () => {
			api.setMinimized(false);
			api.setPhoneSheet(true);
		},
	};
}
