/**
 * What the OPEN thread page knows about its own thread, published for the floating chat bar (which floats over another thread's page and cannot see its cards).
 * PURE: no React, no IO. Keyed by wolf + thread id. Today one fact: a paged `ask` is pending on the page.
 * Approvals are not published here: they are work-request scoped (GET /api/needs-you gives requestId/workId/href, no thread), so they cannot be tied to a thread.
 */

const pending = new Set<string>();
const listeners = new Set<() => void>();

const key = (wolf: string, threadId: string) => `${wolf}\n${threadId}`;

/** The page of `wolf`/`threadId` says whether a paged ask is pending on it (call again with false when it clears or the page unmounts). */
export function setPagePendingAsk(wolf: string, threadId: string, isPending: boolean): void {
	const k = key(wolf, threadId);
	if (pending.has(k) === isPending) return;
	if (isPending) pending.add(k);
	else pending.delete(k);
	for (const l of [...listeners]) l();
}

export function hasPagePendingAsk(wolf: string, threadId: string): boolean {
	return pending.has(key(wolf, threadId));
}

export function subscribePagePending(l: () => void): () => void {
	listeners.add(l);
	return () => void listeners.delete(l);
}
