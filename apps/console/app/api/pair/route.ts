export const dynamic = "force-dynamic";

/**
 * Same-origin relay for the /pair page's typed pairing code: POST {code,label} -> the hub's POST /v1/pair as a browser device, answered with the
 * hub's own status and body ({token,...} or its error envelope). Needs no bearer: the one-time code is the credential, and the page cannot call
 * the hub directly (hubd sends no CORS headers; the console's server is the hub's client). Only code, label and kind "browser" are forwarded.
 */
const LIMIT = 10;
const WINDOW_MS = 60_000;
const attempts = new Map<string, { n: number; resetAt: number }>();

/** hubd's limiter keys on the socket peer, which is always this console; so limit each client here (first x-forwarded-for hop). */
function limited(req: Request): number {
	const now = Date.now();
	for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
	const key = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
	const e = attempts.get(key) ?? { n: 0, resetAt: now + WINDOW_MS };
	e.n++;
	attempts.set(key, e);
	return e.n > LIMIT ? Math.max(1, Math.ceil((e.resetAt - now) / 1000)) : 0;
}

export async function POST(req: Request): Promise<Response> {
	if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
		return Response.json({ message: "Content-Type must be application/json" }, { status: 415 });
	}
	const retry = limited(req);
	if (retry) {
		return Response.json({ error: "Too many pairing attempts; try again shortly.", code: "rate_limited" }, { status: 429, headers: { "Retry-After": String(retry), "Cache-Control": "no-store" } });
	}
	const base = process.env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
	if (!base) return Response.json({ message: "This console has no hub (WOLFPACK_HUB_URL is not set)." }, { status: 501 });
	const b = (await req.json().catch(() => ({}))) as { code?: unknown; label?: unknown };
	if (typeof b.code !== "string" || typeof b.label !== "string") return Response.json({ message: "code and label are required" }, { status: 400 });
	try {
		const res = await fetch(`${base}/v1/pair`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ code: b.code.trim().slice(0, 128), label: b.label.trim().slice(0, 64), kind: "browser" }),
			signal: AbortSignal.timeout(8000),
		});
		const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
		return Response.json(body, { status: res.status, headers: { "Cache-Control": "no-store" } });
	} catch {
		return Response.json({ message: "The hub is not answering." }, { status: 503 });
	}
}
