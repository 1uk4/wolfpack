export const dynamic = "force-dynamic";

/**
 * Same-origin relay for the /pair page's typed pairing code: POST {code,label} -> the hub's POST /v1/pair as a browser device, answered with the
 * hub's own status and body ({token,...} or its error envelope). Needs no bearer: the one-time code is the credential, and the page cannot call
 * the hub directly (hubd sends no CORS headers; the console's server is the hub's client). Only code, label and kind "browser" are forwarded.
 */
export async function POST(req: Request): Promise<Response> {
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
