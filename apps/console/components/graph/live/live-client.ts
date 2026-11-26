/**
 * The live feed (browser): follows GET /api/activity/stream (the console's proxy of the hub's pack.activity frames) and refetches
 * GET /api/activity/presence on every (re)connect and on `resync`. Everything is best effort: no hub (204), an unreachable hub or any
 * failure just leaves the overlay empty and retries slowly; a 401 stops for good (the app shell signs the browser out by itself).
 *
 * Background: the stream is closed while the tab is hidden and reopened (with a fresh presence snapshot) on return.
 * Last-Event-ID: the cursor of the last frame that carried an `id:` (resync) is sent on reconnect; pack.activity frames have none.
 */
import type { ActivityEvent, PresenceSnapshot } from "@wolfpack/protocol";
import type { LiveAction } from "@/src/core";

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

	/** Time of the last applied stream event: a snapshot fetched before it would be older and must not overwrite it. */
	let lastEventAt = -Infinity;

	/** "ok": presence answered 200 with a valid body. "none": no hub (204/404/403) or an invalid body. "auth": 401. "error": network failure. */
	async function snapshot(signal: AbortSignal): Promise<"ok" | "none" | "auth" | "error"> {
		const startedAt = now();
		try {
			const r = await doFetch("/api/activity/presence", { signal, cache: "no-store" });
			if (r.status === 401) return "auth";
			if (r.status !== 200) return "none";
			const snap = (await r.json()) as PresenceSnapshot;
			if (!snap || snap.v !== 1 || !Array.isArray(snap.wolves)) return "none";
			if (lastEventAt <= startedAt) opts.dispatch({ type: "snapshot", snapshot: snap, now: now() });
			return "ok";
		} catch {
			return "error";
		}
	}

	const SLOW_MS = 10 * 60_000;

	async function run(): Promise<void> {
		if (stopped) return;
		const c = new AbortController();
		ctl = c;
		let delayIdx = attempt;
		let gotReal = false;
		try {
			const snap = await snapshot(c.signal);
			if (c.signal.aborted || stopped) return;
			if (snap === "auth") return void (stopped = true);
			if (snap === "none") {
				// No hub (or an old one): stay quiet until the tab comes back or 10 minutes pass.
				timer = setTimeout(() => void run(), SLOW_MS);
				return;
			}
			const headers: Record<string, string> = { Accept: "text/event-stream" };
			if (cursor) headers["Last-Event-ID"] = cursor;
			const r = await doFetch("/api/activity/stream", { headers, signal: c.signal, cache: "no-store" });
			if (r.status === 401) return void (stopped = true);
			if (r.status !== 200 || !r.body) {
				timer = setTimeout(() => void run(), SLOW_MS); // 204/403/404: no hub for us, ask rarely
				return;
			} else {
				const parse = createSseParser((f) => {
					if (f.id) cursor = f.id;
					let j: { type?: string; event?: unknown };
					try {
						j = JSON.parse(f.data);
					} catch {
						return;
					}
					if (j.type === "pack.activity" && isEvent(j.event)) {
						gotReal = true;
						attempt = 0;
						lastEventAt = now();
						opts.dispatch({ type: "event", event: j.event, now: lastEventAt });
					} else if (j.type === "resync") {
						gotReal = true;
						attempt = 0;
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
		// A connection that never carried a real frame (only keepalive comments, or nothing) is not a healthy one: back off slowly.
		if (!gotReal) delayIdx = Math.max(attempt, 4);
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
