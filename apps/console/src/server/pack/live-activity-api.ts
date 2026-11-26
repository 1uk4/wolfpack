/**
 * THE LIVE MAP'S BROWSER FEED (work-wolfpack-BS2Fgro). The browser never talks to the hub (its token stays server-side per request):
 *   GET /api/activity/stream    SSE: the hub's /v1/events with the caller's own bearer, cut down to `pack.activity` and `resync`
 *                               frames (plus keepalive comments). Last-Event-ID is passed through to the hub.
 *   GET /api/activity/presence  the hub's /v1/activity/presence snapshot, as is.
 * The caller's own bearer is forwarded (never the console's env token). No hub configured, or a hub answering 403/404: 204 (the overlay stays empty and the graph works as before). Hub unreachable: 503. No bearer or a hub 401: 401 with the
 * hub-auth header (the browser signs itself out, as for every hub-backed route).
 */
import { bearerOf, HUB_AUTH_HEADER } from "../../core/ui/hub-auth.ts";

const NO_STORE = { "Cache-Control": "no-store" };
const KEEP_TYPES: ReadonlySet<string> = new Set(["pack.activity", "resync"]);

/** One SSE block (without its blank-line terminator) -> itself when it is a comment, a pack.activity or a resync frame, else null. */
export function liveFrameFilter(block: string): string | null {
	if (block.trim() === "") return null;
	const lines = block.split("\n");
	if (lines.every((l) => l.startsWith(":"))) return block; // keepalive
	if (!block.includes('"pack.activity"') && !block.includes('"resync"')) return null; // cheap prefilter: skip JSON.parse for every other frame type
	const data = lines.filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
	try {
		const type = (JSON.parse(data) as { type?: unknown }).type;
		return typeof type === "string" && KEEP_TYPES.has(type) ? block : null;
	} catch {
		return null;
	}
}

/** A TransformStream that re-frames hub SSE bytes and passes only what `liveFrameFilter` keeps. */
export function liveFrameTransform(): TransformStream<Uint8Array, Uint8Array> {
	const dec = new TextDecoder();
	const enc = new TextEncoder();
	let buf = "";
	let dropping = false; // after a runaway frame: discard everything up to the next blank line
	return new TransformStream({
		transform(chunk, ctl) {
			buf += dec.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
			if (dropping) {
				const end = buf.indexOf("\n\n");
				if (end < 0) return void (buf = "");
				buf = buf.slice(end + 2);
				dropping = false;
			}
			let i: number;
			while ((i = buf.indexOf("\n\n")) >= 0) {
				const kept = liveFrameFilter(buf.slice(0, i));
				buf = buf.slice(i + 2);
				if (kept !== null) ctl.enqueue(enc.encode(`${kept}\n\n`));
			}
			if (buf.length > 1_000_000) {
				// A runaway frame is dropped, never buffered forever and never forwarded as garbage.
				buf = "";
				dropping = true;
			}
		},
	});
}

export interface LiveActivityDeps {
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	timeoutMs?: number;
	/** How long the hub may take to answer the stream request with headers (default 15 s); the open stream itself is not limited. */
	connectTimeoutMs?: number;
}

export function createLiveActivityApi(d: LiveActivityDeps = {}) {
	const env = d.env ?? process.env;
	const doFetch = d.fetch ?? fetch;
	const base = () => env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
	const unauthorized = () => new Response(JSON.stringify({ error: "sign in on this device first", code: "unauthorized" }), { status: 401, headers: { ...NO_STORE, "Content-Type": "application/json", [HUB_AUTH_HEADER]: "required" } });

	async function call(req: Request, path: string, headers: Record<string, string>, signal?: AbortSignal, connectMs?: number): Promise<Response> {
		const b = base();
		if (!b) return new Response(null, { status: 204, headers: NO_STORE });
		const token = bearerOf(req.headers.get("authorization"));
		if (!token) return unauthorized();
		let r: Response;
		// The connect timeout covers the headers phase only: it is cleared as soon as the hub answers, so a long stream is never cut.
		const connect = connectMs ? new AbortController() : null;
		const timer = connect ? setTimeout(() => connect.abort(), connectMs) : null;
		const sig = connect && signal ? AbortSignal.any([signal, connect.signal]) : (connect?.signal ?? signal);
		try {
			r = await doFetch(`${b}${path}`, { headers: { Authorization: `Bearer ${token}`, ...headers }, ...(sig ? { signal: sig } : {}) });
		} catch {
			return new Response(null, { status: 503, headers: NO_STORE });
		} finally {
			if (timer) clearTimeout(timer);
		}
		// A hub answer we turn into something else must not leave its body (and socket) open.
		if (!r.ok) void r.body?.cancel().catch(() => {});
		if (r.status === 401) return unauthorized();
		// 403 (a token kind that gets no activity) and 404 (an older hub) both mean "no live data": an empty overlay, no error.
		if (r.status === 403 || r.status === 404) return new Response(null, { status: 204, headers: NO_STORE });
		if (!r.ok) return new Response(null, { status: 502, headers: NO_STORE });
		return r;
	}

	return {
		async stream(req: Request): Promise<Response> {
			const headers: Record<string, string> = { Accept: "text/event-stream" };
			const last = req.headers.get("last-event-id");
			if (last) headers["Last-Event-ID"] = last;
			const r = await call(req, "/v1/events?activity=1", headers, req.signal, d.connectTimeoutMs ?? 15_000); // the hub sends pack.activity only on ?activity=1 and only to device/owner tokens
			if (r.status !== 200 || !r.body) return r;
			return new Response(r.body.pipeThrough(liveFrameTransform()), {
				status: 200,
				headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
			});
		},
		async presence(req: Request): Promise<Response> {
			const r = await call(req, "/v1/activity/presence", { Accept: "application/json" }, AbortSignal.timeout(d.timeoutMs ?? 5000));
			if (r.status !== 200) return r;
			return new Response(r.body, { status: 200, headers: { ...NO_STORE, "Content-Type": "application/json" } });
		},
	};
}

let shared: ReturnType<typeof createLiveActivityApi> | undefined;
export const liveActivityApi = () => (shared ??= createLiveActivityApi());
