/**
 * OWNER PRESENCE PUBLISH (work-wolfpack-BPwZ7wf): POST /api/activity/presence, the browser's "I am looking at X" for the live pack map's
 * "you" node. The console forwards ONE `owner-viewing` ActivityEvent to the hub (POST /v1/activity) with the caller's OWN device bearer
 * (same model as keys-api.ts). The hub validates the token, stamps the pack and refuses non-owner actors, so there is no console gate.
 *
 * Body {kind: "thread"|"work-item"|"kb-entry", id, title?, domain?, ttlMs?}. Reply: ALWAYS 204 (no hub, no bearer, hub down, hub error,
 * timeout 2 s, bad body): presence is decoration and must never surface an error in the UI.
 */
import { ACTIVITY_TTL_MAX_MS, ACTIVITY_VERSION, sanitizeActivityTitle } from "@wolfpack/protocol";
import { bearerOf } from "../../core/ui/hub-auth.ts";

export interface PresenceApiDeps {
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	timeoutMs?: number;
	now?: () => number;
	id?: () => string;
}

const NO_CONTENT = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
const MAX_BODY_BYTES = 4096;
const KINDS: ReadonlySet<string> = new Set(["thread", "work-item", "kb-entry"]);

export function createPresenceApi(d: PresenceApiDeps = {}) {
	const env = d.env ?? process.env;
	const doFetch = d.fetch ?? fetch;
	return {
		async publish(req: Request): Promise<Response> {
			try {
				const base = env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
				const token = bearerOf(req.headers.get("authorization"));
				if (!base || !token) return NO_CONTENT();
				// A real presence body is ~200 bytes: refuse a big one on its declared length, without reading it.
				if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) return NO_CONTENT();
				const b = (await req.json()) as Record<string, unknown>;
				const str = (v: unknown, max = 200) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);
				const kind = str(b.kind);
				const id = str(b.id);
				if (!kind || !id || !KINDS.has(kind)) return NO_CONTENT();
				const title = typeof b.title === "string" ? sanitizeActivityTitle(b.title) : "";
				const domain = str(b.domain, 64);
				const ttl = typeof b.ttlMs === "number" && Number.isFinite(b.ttlMs) ? Math.min(Math.max(Math.trunc(b.ttlMs), 1000), ACTIVITY_TTL_MAX_MS) : 120_000;
				const event = {
					v: ACTIVITY_VERSION,
					id: d.id?.() ?? crypto.randomUUID(),
					pack: "-", // the hub stamps the caller's pack
					ts: (d.now ?? Date.now)(),
					ttlMs: ttl,
					actor: { kind: "owner" },
					verb: "owner-viewing",
					target: { kind, id, ...(title ? { title } : {}), ...(domain ? { domain } : {}) },
				};
				const r = await doFetch(`${base}/v1/activity`, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
					body: JSON.stringify({ v: ACTIVITY_VERSION, events: [event] }),
					signal: AbortSignal.timeout(d.timeoutMs ?? 2000),
				});
				await r.body?.cancel().catch(() => {});
			} catch {
				/* presence never errors */
			}
			return NO_CONTENT();
		},
	};
}
