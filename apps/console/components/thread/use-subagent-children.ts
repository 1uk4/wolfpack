"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOptionalServerEvent, useOptionalServerResync } from "@/components/shell/server-events";
import { threadBase } from "@/components/thread/thread-transport";
import { upsertChild, type ChildThread } from "@/src/core";

/**
 * The thread's children, live: fetched on mount, patched by thread-updated, refetched after a reconnect (and on the
 * wolf stream's needs-you baseline, which the server sends on every reconnect of its own stream).
 * A thread-updated that lands while a fetch is in flight is kept and laid over the fetched list (the patch is newer
 * than the snapshot the fetch may have read), so neither a patch nor the fetched siblings are lost.
 */
export function useSubagentChildren(wolf: string, slug: string, threadId: string): ChildThread[] {
	const [children, setChildren] = useState<ChildThread[]>([]);
	const seq = useRef(0);
	const patches = useRef<ChildThread[]>([]);
	const refetch = useCallback(async () => {
		const n = ++seq.current;
		patches.current = []; // events before this fetch started are in what it reads
		try {
			const res = await fetch(`${threadBase(wolf, slug)}/children`);
			if (!res.ok || n !== seq.current) return;
			const body = (await res.json()) as { threads?: ChildThread[] };
			if (!Array.isArray(body.threads) || n !== seq.current) return;
			setChildren(patches.current.reduce<ChildThread[]>(upsertChild, body.threads));
		} catch {
			/* the next event or resync refetches */
		}
	}, [wolf, slug]);
	useEffect(() => {
		void refetch();
	}, [refetch]);
	useOptionalServerEvent("thread-updated", (p) => {
		if (p.wolf !== wolf || p.thread.parentThreadId !== threadId) return;
		patches.current.push(p.thread);
		setChildren((list) => upsertChild(list, p.thread));
	});
	// The wolf stream's baseline (no thread named) means events may have been missed.
	useOptionalServerEvent("needs-you-changed", (p) => {
		if (p.wolf === wolf && p.threadId === undefined) void refetch();
	});
	useOptionalServerResync(() => void refetch());
	return children;
}
