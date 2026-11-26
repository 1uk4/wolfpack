/** Per-wolf thread buttons of a feature: read each wolf's thread state, and run the button's action (create, go to, reopen). */
import { fetchWolfThreads, openFeatureThread } from "@/components/kb/kb-client";
import { threadCloseApi } from "@/components/thread/thread-close-actions";
import { featureThreadButtons, threadHref, threadSlug, type FeatureThreadButton, type ThreadRow } from "@/src/core";

export async function loadThreadButtons(featureId: string, wolves: readonly string[]): Promise<FeatureThreadButton[]> {
	const threads: Record<string, ThreadRow[]> = {};
	await Promise.all(
		wolves.map(async (wolf) => {
			try {
				const r = await fetchWolfThreads<{ threads?: ThreadRow[] }>(wolf, 0);
				if (r.ok) threads[wolf] = r.data.threads ?? [];
			} catch {
				/* an unreachable wolf: shown as having no thread */
			}
		}),
	);
	return featureThreadButtons(featureId, wolves, threads);
}

/** Runs a button and returns the thread href to go to, or an error message. Open: only navigates. Closed: reopens that thread. None: creates. */
export async function runThreadButton(b: FeatureThreadButton, featureId: string): Promise<{ ok: true; href: string } | { ok: false; message: string }> {
	if (b.state === "open") return { ok: true, href: threadHref(b.wolf, b.threadId!) };
	if (b.state === "closed") {
		try {
			await threadCloseApi.reopen({ wolf: b.wolf, slug: threadSlug(b.wolf, b.threadId!) });
			return { ok: true, href: threadHref(b.wolf, b.threadId!) };
		} catch (e) {
			return { ok: false, message: e instanceof Error ? e.message : "Could not reopen the thread" };
		}
	}
	const r = await openFeatureThread(b.wolf, featureId);
	return r.ok ? { ok: true, href: threadHref(b.wolf, r.data.id) } : { ok: false, message: r.message };
}
