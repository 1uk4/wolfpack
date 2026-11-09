/** Loading the Prompts list (work-wolfpack-FpEanzS): a result or a short error, never a hang. */

/** How long the page waits for the list before it shows an error. Above the client's 20 s request bound, so the server's own answer wins. */
export const PROMPTS_LOAD_BOUND_MS = 20_000;

export type PromptListResult<T> = { prompts: T[] } | { error: string };

export async function loadPromptList<T = unknown>(fetchFn: typeof fetch, wolf: string, boundMs = PROMPTS_LOAD_BOUND_MS): Promise<PromptListResult<T>> {
	const ctl = new AbortController();
	let stalled = false;
	const timer = setTimeout(() => {
		stalled = true;
		ctl.abort();
	}, boundMs);
	try {
		// The stall is also raced explicitly, so a fetch that ignores its signal still ends.
		const stall = new Promise<never>((_, rej) => ctl.signal.addEventListener("abort", () => rej(new Error("stalled"))));
		const r = await Promise.race([fetchFn(`/api/wolves/${encodeURIComponent(wolf)}/prompts`, { signal: ctl.signal }), stall]);
		if (!r.ok) {
			const body = (await r.json().catch(() => null)) as { error?: string; message?: string } | null;
			return { error: body?.error ?? body?.message ?? `request failed (${r.status})` };
		}
		return { prompts: ((await r.json()) as { prompts: T[] }).prompts };
	} catch {
		return { error: stalled ? "The wolf did not answer in time." : "Could not reach the console server." };
	} finally {
		clearTimeout(timer);
	}
}
