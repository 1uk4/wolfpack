/**
 * GET/PUT /api/graph/groups, hub first (work-wolfpack-FnzgC6g).
 *
 * The groups are one list shared by every device of the pack: stored on the hub as pref `graph.groups` (hubd GET/PUT /v1/prefs/:key).
 * Hub prefs are keyed by the token's owner identity, and today every paired device maps to the single owner, so one hub = one list
 * for all consoles and phones. On a Mac-only install the hub runs in the app, so it is local. Without WOLFPACK_HUB_URL, without a
 * bearer, or when the hub does not answer, both routes use the console file (data/graph/groups.json) and the UI never breaks.
 *
 *   GET: hub value -> sanitized. Hub answers "no value yet" -> seed the hub from the file (when it has groups), return those.
 *        Hub down -> the file.
 *   PUT: sanitize; store on the hub; if the hub is not usable, write the file instead. Answers the sanitized list.
 */
import { bearerOf } from "../../core/ui/hub-auth.ts";
import { sanitizeGroups, type GraphGroups } from "../../core/graph/groups.ts";

export const GRAPH_GROUPS_PREF = "graph.groups";
const NO_STORE = { "Cache-Control": "no-store" };

export interface GroupsApiDeps {
	readLocal: () => GraphGroups;
	writeLocal: (raw: unknown) => GraphGroups;
	env?: Record<string, string | undefined>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export function createGroupsApi(d: GroupsApiDeps) {
	const doFetch = d.fetch ?? fetch;

	/** One prefs call: the parsed `{value}` on 2xx, else null (not configured, no bearer, unreachable or refused). */
	async function hub(req: Request, method: "GET" | "PUT", body?: unknown): Promise<{ value: unknown } | null> {
		const env = d.env ?? process.env;
		const base = env.WOLFPACK_HUB_URL?.trim().replace(/\/+$/, "");
		const token = bearerOf(req.headers.get("authorization"));
		if (!base || !token) return null;
		try {
			const r = await doFetch(`${base}/v1/prefs/${GRAPH_GROUPS_PREF}`, {
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
			if (remote && remote.value !== null) return Response.json(sanitizeGroups(remote.value), { headers: NO_STORE });
			const local = d.readLocal();
			if (remote && local.groups.length > 0) void hub(req, "PUT", local).catch(() => {}); // one-time seed; the file stays
			return Response.json(local, { headers: NO_STORE });
		},

		async put(req: Request): Promise<Response> {
			let body: unknown;
			try {
				body = await req.json();
			} catch {
				return Response.json({ error: "invalid JSON body" }, { status: 400 });
			}
			const groups = sanitizeGroups(body);
			const stored = await hub(req, "PUT", groups);
			return Response.json(stored ? groups : d.writeLocal(groups), { headers: NO_STORE });
		},
	};
}
