/**
 * A tiny URL-keyed client cache. `load` serves a value younger than maxAgeMs
 * without a request, shares one in-flight request per URL, and revalidates with
 * the server's ETag (a 304 only refreshes the age). Bounded; oldest entry goes first.
 */
export type StoreEntry<T = unknown> = { data: T; at: number };
export type LoadOptions<T> = { maxAgeMs: number; parse?: (json: unknown) => T };

/** A non-OK answer: the status and the parsed JSON body (null when it had none). */
export class StoreHttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: unknown,
		readonly headers: Headers,
	) {
		super(`HTTP ${status}`);
	}
}

export type DataStoreDeps = {
	fetch?: typeof fetch;
	now?: () => number;
	maxEntries?: number;
};

export function createDataStore(deps: DataStoreDeps = {}) {
	const doFetch = (url: string, init?: RequestInit) => (deps.fetch ?? fetch)(url, init);
	const now = deps.now ?? Date.now;
	const maxEntries = deps.maxEntries ?? 50;
	const entries = new Map<string, StoreEntry & { etag?: string }>();
	const inflight = new Map<string, Promise<unknown>>();
	const subs = new Map<string, Set<() => void>>();

	const notify = (url: string) => {
		for (const fn of [...(subs.get(url) ?? [])]) fn();
	};

	function put(url: string, entry: StoreEntry & { etag?: string }) {
		entries.delete(url);
		entries.set(url, entry);
		while (entries.size > maxEntries) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	}

	function read<T = unknown>(url: string): StoreEntry<T> | undefined {
		const e = entries.get(url);
		return e ? { data: e.data as T, at: e.at } : undefined;
	}

	function load<T = unknown>(url: string, opts: LoadOptions<T>): Promise<T> {
		const hit = entries.get(url);
		if (hit && now() - hit.at < opts.maxAgeMs) return Promise.resolve(hit.data as T);
		// Only a read that accepts cached data joins a request already in flight; a forced refresh (maxAgeMs 0, e.g. after an event) may not,
		// because that request could have been sent before the change that triggered the refresh.
		const pending = inflight.get(url);
		if (pending && opts.maxAgeMs > 0) return pending as Promise<T>;
		const slot: { p?: Promise<T> } = {};
		const p: Promise<T> = (async () => {
			try {
				const headers: Record<string, string> = {};
				if (hit?.etag) headers["If-None-Match"] = hit.etag;
				const res = await doFetch(url, { headers });
				if (res.status === 304 && hit) {
					put(url, { ...hit, at: now() });
					return hit.data as T;
				}
				if (!res.ok) throw new StoreHttpError(res.status, await res.json().catch(() => null), res.headers);
				const json = (await res.json()) as unknown;
				const data = opts.parse ? opts.parse(json) : (json as T);
				put(url, { data, at: now(), etag: res.headers?.get?.("ETag") ?? undefined });
				notify(url);
				return data;
			} finally {
				if (inflight.get(url) === slot.p) inflight.delete(url);
			}
		})();
		slot.p = p;
		inflight.set(url, p);
		return p;
	}

	function subscribe(url: string, fn: () => void): () => void {
		let set = subs.get(url);
		if (!set) subs.set(url, (set = new Set()));
		set.add(fn);
		return () => {
			set.delete(fn);
		};
	}

	/** Marks every cached URL starting with `prefix` stale (age zero, ETag kept) so the next load revalidates. */
	function invalidate(prefix: string) {
		for (const [url, e] of entries) if (url.startsWith(prefix)) e.at = Number.NEGATIVE_INFINITY;
	}

	/** Drops every stored value (sign-out, tests). */
	function clear() {
		entries.clear();
		inflight.clear();
	}

	return { read, load, subscribe, invalidate, clear };
}

export const dataStore = createDataStore();
