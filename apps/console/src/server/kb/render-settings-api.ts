/**
 * GET/PUT /api/graph/render-settings, hub first (work-wolfpack-H1OQNIh).
 *
 * The settings are per person, stored on the hub as pref `graph.render-settings` (hubd GET/PUT /v1/prefs/:key) with the caller's own
 * device bearer, so every device of that person shows the same graph settings. Without WOLFPACK_HUB_URL, without a bearer, or when
 * the hub does not answer, both routes use the local file (data/graph/render-settings.json) exactly as before: the UI never breaks.
 *
 *   GET: hub value -> sanitized, returned. Hub answers "no value yet" -> MIGRATION: seed the hub from the local file (when it has
 *        settings), return those; the file is left in place, never deleted. Hub down -> the local file (null when none).
 *   PUT: sanitize; store on the hub; if the hub is not usable, write the local file instead. Answers the sanitized settings.
 */
import { bearerOf } from "../../core/ui/hub-auth.ts";
import { sanitizeRenderSettings, type GraphRenderSettings } from "../../core/graph/render-settings.ts";

export const RENDER_SETTINGS_PREF = "graph.render-settings";
const NO_STORE = { "Cache-Control": "no-store" };

export interface RenderSettingsApiDeps {
	readLocal: () => GraphRenderSettings | null;
	writeLocal: (raw: unknown) => GraphRenderSettings;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export function createRenderSettingsApi(d: RenderSettingsApiDeps) {
	const doFetch = d.fetch ?? fetch;

	/** One prefs call: the parsed `{value}` on 2xx, else null (not configured, no bearer, unreachable or refused). */
	async function hub(req: Request, method: "GET" | "PUT", body?: unknown): Promise<{ value: unknown } | null> {
		const env = d.env ?? process.env;
		const base = env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
		const token = bearerOf(req.headers.get("authorization"));
		if (!base || !token) return null;
		try {
			const r = await doFetch(`${base}/v1/prefs/${RENDER_SETTINGS_PREF}`, {
				method,
				headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
				...(body === undefined ? {} : { body: JSON.stringify({ value: body }) }),
				signal: AbortSignal.timeout(d.timeoutMs ?? 4000),
			});
			if (!r.ok) return null;
			const json = (await r.json()) as { value?: unknown };
			return { value: json.value ?? null };
		} catch {
			return null;
		}
	}

	return {
		async get(req: Request): Promise<Response> {
			const remote = await hub(req, "GET");
			if (remote && remote.value !== null) return Response.json(sanitizeRenderSettings(remote.value), { headers: NO_STORE });
			const local = d.readLocal();
			if (remote && local) void hub(req, "PUT", local).catch(() => {}); // one-time seed, fire and forget: a slow hub never delays the first load; the file stays
			return Response.json(local, { headers: NO_STORE });
		},

		async put(req: Request): Promise<Response> {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return Response.json({ error: "invalid JSON body" }, { status: 400 });
			}
			const settings = sanitizeRenderSettings(body);
			const stored = await hub(req, "PUT", settings);
			return Response.json(stored ? settings : d.writeLocal(settings), { headers: NO_STORE });
		},
	};
}
