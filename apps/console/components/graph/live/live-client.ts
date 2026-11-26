/**
 * The live feed (browser): follows GET /api/activity/stream (the console's proxy of the hub's pack.activity frames) and refetches
 * GET /api/activity/presence on every (re)connect and on `resync`. Everything is best effort: no hub (204), an unreachable hub or any
 * failure just leaves the overlay empty and retries slowly; a 401 stops for good (the app shell signs the browser out by itself).
 *
 * Background: the stream is closed while the tab is hidden and reopened (with a fresh presence snapshot) on return.
 * Last-Event-ID: the cursor of the last frame that carried an `id:` (resync) is sent on reconnect; pack.activity frames have none.
 */
import type { ActivityEvent, PresenceSnapshot } from "@wolfpack/protocol";
import type { LiveAction } from "@/src/core/graph/live/live-state";

export interface SseFrame { id?: string; data: string }

/** Incremental SSE parser: feed text chunks, get whole frames (comments and empty blocks are skipped). */
export function createSseParser(onFrame: (f: SseFrame) => void): (chunk: string) => void {
	let buf = "";
	return (chunk) => {
		buf += chunk.replace(/\r\n/g, "\n");
		let i: number;
		while ((i = buf.indexOf("\n\n")) >= 0) {
			const block = buf.slice(0, i);
			buf = buf.slice(i + 2);
			let id: string | undefined;
			const data: string[] = [];
			for (const line of block.split("\n")) {
				if (line.startsWith("id:")) id = line.slice(3).trim();
				else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
			}
			if (data.length) onFrame({ id, data: data.join("\n") });
		}
		if (buf.length > 1_000_000) buf = "";
	};
}

const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];

export interface LiveFeedOptions {
	dispatch: (a: LiveAction) => void;
	now?: () => number;
	fetchImpl?: typeof fetch;
}

const isEvent = (x: unknown): x is ActivityEvent => {
	const e = x as Partial<ActivityEvent> | null;
	return !!e && typeof e === "object" && typeof e.verb === "string" && typeof e.id === "string" && !!e.actor && typeof e.actor === "object" && typeof e.ttlMs === "number";
};

/** Start following; returns `stop`. Safe to call with no hub (the stream answers 204 and the overlay stays empty). */
export function startLiveFeed(opts: LiveFeedOptions): () => void {
	const now = opts.now ?? Date.now;
	const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
	let stopped = false;
	let ctl: AbortController | null = null;
	let cursor: string | undefined;
	let attempt = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function snapshot(signal: AbortSignal): Promise<void> {
		try {
			const r = await doFetch("/api/activity/presence", { signal, cache: "no-store" });
			if (r.status !== 200) return;
			const snap = (await r.json()) as PresenceSnapshot;
			if (snap && snap.v === 1 && Array.isArray(snap.wolves)) opts.dispatch({ type: "snapshot", snapshot: snap, now: now() });
		} catch {
			/* no snapshot: the overlay fills from live frames */
		}
	}

	async function run(): Promise<void> {
		if (stopped) return;
		const c = new AbortController();
		ctl = c;
		let delayIdx = attempt;
		try {
			await snapshot(c.signal);
			const headers: Record<string, string> = { Accept: "text/event-stream" };
			if (cursor) headers["Last-Event-ID"] = cursor;
			const r = await doFetch("/api/activity/stream", { headers, signal: c.signal, cache: "no-store" });
			if (r.status === 401) return void (stopped = true);
			if (r.status !== 200 || !r.body) {
				delayIdx = Math.max(attempt, 4); // no hub / not reachable: ask rarely
			} else {
				const parse = createSseParser((f) => {
					attempt = 0;
					if (f.id) cursor = f.id;
					let j: { type?: string; event?: unknown };
					try {
						j = JSON.parse(f.data);
					} catch {
						return;
					}
					if (j.type === "pack.activity" && isEvent(j.event)) opts.dispatch({ type: "event", event: j.event, now: now() });
					else if (j.type === "resync") {
						opts.dispatch({ type: "resync", now: now() });
						void snapshot(c.signal);
					}
				});
				const reader = r.body.getReader();
				const dec = new TextDecoder();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					parse(dec.decode(value, { stream: true }));
				}
			}
		} catch {
			/* aborted or dropped: reconnect below */
		}
		if (stopped || c.signal.aborted) return;
		attempt = delayIdx + 1;
		timer = setTimeout(() => void run(), BACKOFF_MS[Math.min(delayIdx, BACKOFF_MS.length - 1)]);
	}

	const onVisibility = () => {
		if (stopped) return;
		if (document.hidden) {
			ctl?.abort();
			if (timer) clearTimeout(timer);
			timer = null;
		} else {
			if (timer) clearTimeout(timer);
			timer = null;
			ctl?.abort();
			attempt = 0;
			void run(); // back from the background: a fresh stream and a fresh presence snapshot
		}
	};
	document.addEventListener("visibilitychange", onVisibility);
	if (!document.hidden) void run();

	return () => {
		stopped = true;
		ctl?.abort();
		if (timer) clearTimeout(timer);
		document.removeEventListener("visibilitychange", onVisibility);
	};
}
